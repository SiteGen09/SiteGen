import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, apiError } from '@/lib/api/errors';
import { readTextBody } from '@/lib/api/request-body';
import { fulfillmentResult, prepareWhopEvent } from '@/lib/billing/fulfillment';
import { verifyWhopRequest, whopEventSchema } from '@/lib/billing/whop';
import { logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';

const storedEvent = z.object({ id: z.string(), payload_hash: z.string(), event_type: z.string(), handled: z.boolean() });

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, component: 'whop.webhook' });
  try {
    const secret = process.env.WHOP_WEBHOOK_SECRET;
    const accountId = process.env.WHOP_ACCOUNT_ID;
    if (!secret || !accountId) throw new Error('Webhook configuration is missing');
    const rawBody = await readTextBody(request, 1_048_576);
    const verification = verifyWhopRequest(rawBody, request.headers, secret);
    if (!verification.ok) return apiError('unauthorized', 'Invalid webhook signature', requestId, 401);
    let json: unknown;
    try { json = JSON.parse(rawBody); } catch {
      return apiError('invalid_request', 'Invalid JSON', requestId, 400);
    }
    const parsed = whopEventSchema.safeParse(json);
    if (!parsed.success) return apiError('invalid_request', 'Invalid webhook envelope', requestId, 400);
    const event = parsed.data;
    if ((event.account_id ?? event.company_id) !== accountId) {
      return apiError('forbidden', 'Unexpected billing account', requestId, 403);
    }
    // Legacy `x-whop-signature` deliveries have no Standard Webhooks id.
    // The event id is stable across retries and therefore safe as a fallback
    // delivery identity for the audit table.
    const deliveryId = request.headers.get('webhook-id') ?? `legacy-${event.id}`;
    const payloadHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
    const service = createServiceClient();
    // Fast path only. The RPC repeats this check under a transaction lock to
    // close the race between concurrent requests and roll back failed claims.
    const [byEvent, byDelivery] = await Promise.all([
      service.from('payments_log').select('id,payload_hash,event_type,handled').eq('id', event.id).maybeSingle(),
      service.from('payments_log').select('id,payload_hash,event_type,handled').eq('delivery_id', deliveryId).maybeSingle(),
    ]);
    if (byEvent.error || byDelivery.error) throw new Error('Webhook audit lookup failed');
    for (const row of [byEvent.data, byDelivery.data]) {
      if (!row) continue;
      const previous = storedEvent.parse(row);
      if (previous.id !== event.id || previous.payload_hash !== payloadHash || previous.event_type !== event.type) {
        return apiError('idempotency_conflict', 'Webhook identity conflict', requestId, 409);
      }
    }
    const prior = byEvent.data ?? byDelivery.data;
    if (prior) return Response.json({ ok: true, duplicate: true, handled: storedEvent.parse(prior).handled, request_id: requestId });

    const prepared = await prepareWhopEvent(service, event, log);
    const { data, error } = await service.rpc('fulfill_whop_event', {
      p_id: event.id, p_delivery_id: deliveryId, p_type: event.type, p_hash: payloadHash,
      // Keep a minimal audit payload. Do not store receipt PII or signing metadata.
      p_payload: { id: event.id, type: event.type, resource_id: event.data.id ?? null, account_id: accountId },
      p_purchase: prepared.purchase, p_membership: prepared.membership, p_dispute: prepared.dispute,
    });
    if (error) throw new Error('Atomic webhook fulfillment failed: ' + error.message);
    const result = fulfillmentResult.parse(data);
    log.info('whop.webhook.processed', { event_id: event.id, event_type: event.type, handled: result.handled, credits_added: result.creditsAdded });
    return Response.json({ ok: true, ...result, request_id: requestId });
  } catch (error) {
    if (error instanceof ApiError) return apiError(error.code, error.message, requestId, error.status);
    log.error('whop.webhook.handler_failed', { error_type: error instanceof Error ? error.name : 'unknown' });
    // A failed write must not be acknowledged: Whop needs to redeliver it.
    return apiError('internal_error', 'Webhook processing failed', requestId, 500);
  }
}

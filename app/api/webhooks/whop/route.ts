/**
 * Whop webhook receiver — the only thing that mutates billing state.
 *
 * Order is load-bearing (docs: https://docs.whop.com/developer/guides/webhooks):
 *  1. read the RAW body; the signature covers those exact bytes
 *  2. verify `webhook-signature` before parsing anything
 *  3. record the event under its `event_id` primary key; a conflict means Whop
 *     is retrying a delivery we already processed, so we ack without replaying
 *  4. apply the effect; every write is idempotent (entitlement upsert,
 *     `ledger.request_id` unique), so a partial failure can be retried safely
 *
 * Delivery is at-least-once and unordered. A handler failure deletes the event
 * marker and answers 500 so Whop's retry reprocesses the event.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { apiError } from '@/lib/api/errors';
import {
  applyMembership,
  applyPaymentFailed,
  applySubscriptionPayment,
  applyTopup,
  classifyEvent,
  isTopupPayment,
  normalizeMembership,
  verifyWhopRequest,
  whopEventSchema,
  whopMembershipSchema,
  whopPaymentSchema,
  type WhopEvent,
} from '@/lib/billing/whop';
import { logger, type Logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

const UNIQUE_VIOLATION = '23505';

interface HandledEvent {
  handled: boolean;
  detail: string;
  userId?: string | null;
  grantedCredits?: number;
}

async function handleEvent(
  service: SupabaseClient,
  event: WhopEvent,
  log: Logger,
): Promise<HandledEvent> {
  const kind = classifyEvent(event.type);

  switch (kind) {
    case 'membership_valid':
    case 'membership_invalid': {
      const parsed = whopMembershipSchema.safeParse(event.data);
      if (!parsed.success) {
        log.warn('whop.event.unparseable_membership', { event_type: event.type });
        return { handled: false, detail: 'unparseable_membership' };
      }
      const membership = normalizeMembership(parsed.data);
      if (membership === null) {
        log.warn('whop.event.membership_without_plan', { event_type: event.type });
        return { handled: false, detail: 'membership_without_plan' };
      }
      const result = await applyMembership(service, membership, {
        intent: kind === 'membership_valid' ? 'valid' : 'invalid',
        log,
      });
      return {
        handled: result.outcome === 'applied',
        detail: result.outcome,
        userId: result.userId,
        grantedCredits: result.grantedCredits,
      };
    }

    case 'payment_failed': {
      const parsed = whopPaymentSchema.safeParse(event.data);
      if (!parsed.success) {
        log.warn('whop.event.unparseable_payment', { event_type: event.type });
        return { handled: false, detail: 'unparseable_payment' };
      }
      const result = await applyPaymentFailed(service, parsed.data, { log });
      return { handled: result.outcome === 'applied', detail: result.outcome, userId: result.userId };
    }

    case 'payment_succeeded': {
      const parsed = whopPaymentSchema.safeParse(event.data);
      if (!parsed.success) {
        log.warn('whop.event.unparseable_payment', { event_type: event.type });
        return { handled: false, detail: 'unparseable_payment' };
      }
      const result = isTopupPayment(parsed.data)
        ? await applyTopup(service, parsed.data, { log })
        : await applySubscriptionPayment(service, parsed.data, { log });
      return {
        handled: result.outcome === 'applied',
        detail: result.detail ?? result.outcome,
        userId: result.userId,
        grantedCredits: result.grantedCredits,
      };
    }

    case 'other':
      return { handled: false, detail: 'ignored_event_type' };
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, component: 'whop.webhook' });

  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (secret === undefined || secret === '') {
    // Fail closed: an unverifiable delivery is never applied.
    log.error('whop.webhook.secret_missing', { alert: true });
    return apiError('internal_error', 'Webhook verification is not configured', requestId, 500);
  }

  const rawBody = await request.text();
  const verification = verifyWhopRequest(rawBody, request.headers, secret);
  if (!verification.ok) {
    log.warn('whop.webhook.rejected', { reason: verification.reason });
    return apiError('unauthorized', 'Invalid webhook signature', requestId, 401);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    log.warn('whop.webhook.invalid_json');
    return apiError('invalid_request', 'Body is not valid JSON', requestId, 400);
  }

  const event = whopEventSchema.safeParse(json);
  if (!event.success) {
    log.warn('whop.webhook.invalid_envelope', { detail: event.error.message });
    return apiError('invalid_request', 'Unrecognized webhook envelope', requestId, 400);
  }

  const service = createServiceClient();
  const { error: insertError } = await service.from('billing_events').insert({
    event_id: event.data.id,
    provider: 'whop',
    kind: event.data.type,
    payload: json,
  });
  if (insertError !== null) {
    if (insertError.code === UNIQUE_VIOLATION) {
      log.info('whop.webhook.duplicate', { event_id: event.data.id, event_type: event.data.type });
      return Response.json({ ok: true, duplicate: true, request_id: requestId });
    }
    log.error('whop.webhook.event_store_failed', {
      event_id: event.data.id,
      detail: insertError.message,
    });
    return apiError('internal_error', 'Could not record billing event', requestId, 500);
  }

  try {
    const result = await handleEvent(service, event.data, log);
    log.info('whop.webhook.processed', {
      event_id: event.data.id,
      event_type: event.data.type,
      handled: result.handled,
      detail: result.detail,
      user_id: result.userId ?? null,
      granted_credits: result.grantedCredits ?? 0,
    });
    return Response.json({ ok: true, handled: result.handled, request_id: requestId });
  } catch (error) {
    // Drop the marker so the retry is not swallowed by the dedupe check.
    await service.from('billing_events').delete().eq('event_id', event.data.id);
    log.error('whop.webhook.handler_failed', {
      alert: true,
      event_id: event.data.id,
      event_type: event.data.type,
      detail: error instanceof Error ? error.message : 'unknown error',
    });
    return apiError('internal_error', 'Webhook processing failed', requestId, 500);
  }
}

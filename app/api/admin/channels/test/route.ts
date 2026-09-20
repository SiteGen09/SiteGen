import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { requireAdmin, writeAudit } from '@/lib/api/admin';
import { ApiError, apiError } from '@/lib/api/errors';
import { logger } from '@/lib/log';
import { PROVIDERS, resolvePlatformCreds, type Provider } from '@/lib/admin/credentials';
import { probeCredentials } from '@/lib/admin/probe';
import { createServiceClient } from '@/lib/supabase/service';

const bodySchema = z.object({ channelId: z.string().trim().min(1) });

const channelSchema = z.object({
  id: z.string(),
  provider: z.enum(PROVIDERS),
  base_url: z.string().nullable(),
  model_id: z.string(),
  input_per_mtok: z.coerce.number().nonnegative(),
  output_per_mtok: z.coerce.number().nonnegative(),
  cached_per_mtok: z.coerce.number().nonnegative(),
});

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'admin.channels.test' });

  try {
    const ctx = await requireAdmin();

    const raw: unknown = await request.json().catch(() => null);
    const parsedBody = bodySchema.safeParse(raw);
    if (!parsedBody.success) {
      return apiError('invalid_request', 'channelId is required', requestId, 400);
    }

    const service = createServiceClient();
    const { data, error } = await service
      .from('channels')
      .select('id, provider, base_url, model_id, input_per_mtok, output_per_mtok, cached_per_mtok')
      .eq('id', parsedBody.data.channelId)
      .maybeSingle();

    if (error !== null) {
      return apiError('internal_error', 'failed to load channel', requestId, 500);
    }
    const channel = channelSchema.safeParse(data as unknown);
    if (!channel.success) {
      return apiError('not_found', 'channel not found', requestId, 404);
    }

    const provider: Provider = channel.data.provider;
    const creds = await resolvePlatformCreds(provider, channel.data.base_url);
    const probe = await probeCredentials(creds, channel.data.model_id, {
      inputPerMTok: channel.data.input_per_mtok,
      outputPerMTok: channel.data.output_per_mtok,
      cachedPerMTok: channel.data.cached_per_mtok,
    });

    await writeAudit(
      ctx.user.id,
      'channel.test',
      `channel:${channel.data.id}`,
      null,
      { ok: probe.ok, latency_ms: probe.latencyMs, cost_usd: probe.costUsd, error: probe.error ?? null },
    );

    log.info('channel test complete', { channel_id: channel.data.id, ok: probe.ok });

    return Response.json({
      ok: probe.ok,
      latency_ms: probe.latencyMs,
      cost_usd: probe.costUsd,
      ...(probe.error !== undefined ? { error: probe.error } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return apiError(err.code, err.message, requestId, err.status);
    }
    log.error('channel test failed', { error: err instanceof Error ? err.message : String(err) });
    return apiError('internal_error', 'channel test failed', requestId, 500);
  }
}

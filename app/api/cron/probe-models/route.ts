import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { resolveChannel } from '@/lib/ai/channels';
import { resolvePlatformCreds } from '@/lib/admin/credentials';
import { probeCredentials } from '@/lib/admin/probe';
import { sql } from '@/lib/db';
import { createServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const maxDuration = 300;

function authorized(header: string | null, secret: string): boolean {
  if (header === null) return false;
  const expected = 'Bearer ' + secret;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(expected, 'utf8'));
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 500 });
  // timingSafeEqual rejects unequal byte lengths, including a same-length
  // Unicode header. Such malformed credentials must still return a 401.
  try {
    if (!authorized(request.headers.get('authorization'), secret))
      return Response.json({ error: 'Invalid cron credentials' }, { status: 401 });
  } catch {
    return Response.json({ error: 'Invalid cron credentials' }, { status: 401 });
  }

  // DISTINCT ON uses the dispatch priority/status/id order. One failing replica
  // must not multiply a model/source's contribution to the hourly board.
  const raw = await sql.unsafe(
    "SELECT DISTINCT ON (c.public_model_id, c.source_id) c.id, date_trunc('hour', now()) AS bucket_hour " +
      'FROM channels c JOIN sources s ON s.id=c.source_id WHERE c.public_model_id IS NOT NULL ' +
      "AND NOT c.is_byok AND c.pricing_type='token' AND c.status <> 'off' AND s.status <> 'off' " +
      "ORDER BY c.public_model_id, c.source_id, c.priority DESC, (c.status='active') DESC, c.id",
  );
  const representatives = z
    .array(
      z.object({
        id: z.string(),
        bucket_hour: z.union([z.string(), z.date()]).transform((v) => new Date(v).toISOString()),
      }),
    )
    .parse(raw);
  const service = createServiceClient();
  let failed = 0;
  // Bounded concurrency keeps the job under the function deadline without
  // opening an unbounded burst against every upstream account at once.
  for (let offset = 0; offset < representatives.length; offset += 8) {
    await Promise.all(
      representatives.slice(offset, offset + 8).map(async (row) => {
        const started = Date.now();
        let status: 'ok' | 'error' | 'timeout' = 'error';
        let latency = 0;
        try {
          const channel = await resolveChannel(row.id);
          if (channel === null) throw new Error('Channel unavailable');
          const result = await probeCredentials(
            await resolvePlatformCreds(channel.provider, channel.baseUrl),
            channel.modelId,
            channel.rates,
          );
          status = result.ok
            ? 'ok'
            : /timeout|timed out|aborted/i.test(result.error ?? '')
              ? 'timeout'
              : 'error';
          latency = result.latencyMs;
        } catch {
          latency = Date.now() - started;
        }
        if (status !== 'ok') failed += 1;
        // Never persist raw provider errors: they may contain endpoint URLs or
        // headers. The detailed operational result belongs in protected logs.
        const { error } = await service.from('model_health_checks').upsert(
          {
            channel_id: row.id,
            bucket_hour: row.bucket_hour,
            status,
            latency_ms: latency,
            error_detail: status === 'ok' ? null : 'Synthetic probe ' + status,
            checked_at: new Date().toISOString(),
          },
          { onConflict: 'channel_id,bucket_hour' },
        );
        if (error) throw new Error('Could not persist probe result');
      }),
    );
  }
  return Response.json({ checked: representatives.length, failed });
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { after } from 'next/server';
import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';
import { isPolicyRejection, localPolicy } from './policy';

interface GuardContext { request: Request; id: string; owner?: string; admitted: boolean; violation?: Promise<void>; pending: Promise<unknown>[]; retryAfter?: number }
const contexts = new AsyncLocalStorage<GuardContext>();
const log = logger({ component: 'guardrails' });

export function generationRequestId(): string | undefined { return contexts.getStore()?.id; }
export function trackGeneration(work: Promise<unknown>): void {
  contexts.getStore()?.pending.push(work.catch(() => undefined));
}

function setting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Only trust a proxy-controlled header; arbitrary X-Forwarded-For is spoofable. */
export function clientIpKey(request: Request): string | null {
  const header = process.env.VERCEL === '1' ? 'x-vercel-forwarded-for' : process.env.GUARD_TRUSTED_IP_HEADER;
  if (!header) return null;
  const ip = request.headers.get(header)?.split(',')[0]?.trim();
  if (!ip || !isIP(ip)) return null;
  const secret = process.env.GUARD_IP_HASH_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  const canonical = isIP(ip) === 6 ? new URL('http://[' + ip + ']').hostname : ip;
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

const decisionSchema = z.object({ allowed: z.boolean(), reason: z.string().optional(), retry_after: z.number().optional() });

/** One atomic DB call covers status, cooldown, account/IP RPM and concurrency. */
export async function admitGeneration(owner: string): Promise<void> {
  const ctx = contexts.getStore();
  if (!ctx) throw new ApiError('internal_error', 'generation guard is unavailable', 503);
  if (ctx.admitted) {
    if (ctx.owner !== owner) throw new Error('generation identity changed');
    return;
  }
  ctx.owner = owner;
  const { data, error } = await createServiceClient().rpc('guard_admit', {
    p_user: owner, p_request: ctx.id, p_ip: clientIpKey(ctx.request),
    p_account_rpm: setting('GUARD_ACCOUNT_RPM', 60), p_ip_rpm: setting('GUARD_IP_RPM', 180),
    p_concurrency: setting('GUARD_CONCURRENCY', 4),
  });
  if (error) throw new ApiError('channel_unavailable', 'request protection is temporarily unavailable', 503);
  const decision = decisionSchema.parse(data);
  if (!decision.allowed) {
    ctx.retryAfter = decision.retry_after ?? 60;
    if (decision.reason === 'inactive') throw new ApiError('forbidden', 'generation is unavailable for this account', 403);
    throw Object.assign(new ApiError('rate_limited', decision.reason === 'cooldown'
      ? 'generation is temporarily restricted after repeated policy violations'
      : 'too many requests; please try again shortly', 429), { retryAfter: decision.retry_after ?? 60 });
  }
  ctx.admitted = true;
}

export async function recordPolicyViolation(category: string, owner?: string, requestId?: string): Promise<void> {
  const ctx = contexts.getStore();
  const user = owner ?? ctx?.owner;
  const id = requestId ?? ctx?.id;
  if (!user || !id) return;
  if (!owner && ctx?.violation) return ctx.violation;
  const work = (async () => {
    const { error } = await createServiceClient().rpc('guard_record_violation', {
      p_user: user, p_request: id, p_category: category,
      p_threshold: setting('GUARD_VIOLATION_THRESHOLD', 5),
      p_cooldown_seconds: setting('GUARD_COOLDOWN_SECONDS', 3600),
    });
    if (error) log.error('guard.violation_record_failed', { request_id: id, alert: true });
  })().catch(() => { log.error('guard.violation_record_failed', { request_id: id, alert: true }); });
  if (!owner && ctx) ctx.violation = work;
  await work;
}

export async function observePolicyRejection(error: unknown): Promise<void> {
  if (isPolicyRejection(error)) await recordPolicyViolation('provider/content-policy');
}

export async function enforceLocalPolicy(text: string): Promise<void> {
  if (text.length > 200000) throw new ApiError('invalid_request', 'input exceeds the 200,000 character limit', 413);
  const categories = localPolicy(text);
  if (categories.length) {
    await recordPolicyViolation(categories[0]!);
    throw new ApiError('content_policy_violation', 'this request is not allowed by the service content policy', 400);
  }
}

/** Count bytes while reading, rather than trusting Content-Length. */
export async function boundedRequest(request: Request, maxBytes: number): Promise<Request> {
  if (Number(request.headers.get('content-length')) > maxBytes) throw new ApiError('invalid_request', 'request body is too large', 413);
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError('invalid_request', 'request body is too large', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes, signal: request.signal });
}

/** after() retains leases through streaming and disconnect work, not just POST. */
export function guardedRoute(handler: (request: Request) => Promise<Response>,
  errorResponse: (error: unknown, requestId: string) => Response, maxBytes = 1024 * 1024) {
  return async (request: Request): Promise<Response> => {
    const ctx: GuardContext = { request, id: randomUUID(), admitted: false, pending: [] };
    return contexts.run(ctx, async () => {
      after(async () => {
        await Promise.allSettled(ctx.pending);
        if (ctx.violation) await ctx.violation;
        if (ctx.admitted) {
          const { error } = await createServiceClient().rpc('guard_release', { p_request: ctx.id });
          if (error) log.error('guard.release_failed', { request_id: ctx.id });
        }
      });
      try {
        const response = await handler(await boundedRequest(request, maxBytes));
        if (response.status === 429 && !response.headers.has('Retry-After')) response.headers.set('Retry-After', String(ctx.retryAfter ?? 60));
        return response;
      } catch (error) {
        await observePolicyRejection(error);
        const response = errorResponse(error, ctx.id);
        if (error instanceof ApiError && error.status === 429) response.headers.set('Retry-After', String((error as ApiError & { retryAfter?: number }).retryAfter ?? 60));
        return response;
      }
    });
  };
}

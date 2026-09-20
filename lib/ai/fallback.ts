import type { TokenRates } from '@/lib/ai/pricing';
import type { Provider } from '@/lib/ai/providers';

/** Max channels visited in one fallback walk, including the starting channel. */
const MAX_CHAIN_DEPTH = 5;

/**
 * Plain projection of a provider channel row. Passed in by the caller so this
 * module stays free of DB access.
 */
export interface ChannelRow {
  id: string;
  provider: Provider;
  baseUrl: string | null;
  modelId: string;
  /** Decimal string, e.g. '1.00'; '0' means BYOK (no credits charged). */
  creditMultiplier: string;
  status: string;
  fallbackTo: string | null;
  /**
   * USD list price per million tokens for this channel's model, held as
   * numbers because `numeric(12,6)` arrives from PostgREST as a string.
   */
  rates: TokenRates;
}

export interface FallbackResult<T> {
  value: T;
  channelId: string;
  attempts: Array<{ channelId: string; error?: string }>;
}

const RETRYABLE_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'FetchError',
]);

const RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETRESET',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function numericProp(source: Record<string, unknown>, key: string): number | undefined {
  const raw = source[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function stringProp(source: Record<string, unknown>, key: string): string | undefined {
  const raw = source[key];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Classifies an error as worth trying the next channel with: HTTP 429, HTTP 5xx,
 * or a timeout/network failure.
 *
 * An explicit HTTP status outranks the AI SDK's `isRetryable` flag, which also
 * marks 408/409 retryable; a 4xx other than 429 must never burn a fallback
 * channel. `isRetryable` is honored when no status is present, which is the
 * transport-failure case (flag set, no response).
 */
export function isRetryableError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;

  const source = err as Record<string, unknown>;

  const status = numericProp(source, 'statusCode') ?? numericProp(source, 'status');
  if (status !== undefined) return status === 429 || (status >= 500 && status < 600);

  const response = source['response'];
  if (typeof response === 'object' && response !== null) {
    const nested = numericProp(response as Record<string, unknown>, 'status');
    if (nested !== undefined) return nested === 429 || (nested >= 500 && nested < 600);
  }

  const flag = source['isRetryable'];
  if (typeof flag === 'boolean') return flag;

  const name = stringProp(source, 'name');
  if (name !== undefined && RETRYABLE_NAMES.has(name)) return true;

  const code = stringProp(source, 'code');
  if (code !== undefined && RETRYABLE_CODES.has(code)) return true;

  const cause = source['cause'];
  return cause === undefined || cause === null ? false : isRetryableError(cause);
}

/**
 * Walks the `fallback_to` chain starting at `start`, invoking `attempt` on each
 * usable channel.
 *
 * Channels with status `'off'` are skipped without an attempt. A failed attempt
 * advances to the next channel only when {@link isRetryableError} holds;
 * anything else is rethrown untouched. The walk is cycle-safe and bounded to
 * {@link MAX_CHAIN_DEPTH} channels. When the chain is exhausted the last error
 * is thrown.
 */
export async function callWithFallback<T>(
  start: ChannelRow,
  resolve: (id: string) => Promise<ChannelRow | null>,
  attempt: (channel: ChannelRow) => Promise<T>,
): Promise<FallbackResult<T>> {
  const attempts: Array<{ channelId: string; error?: string }> = [];
  const visited = new Set<string>();

  let current: ChannelRow | null = start;
  let lastError: unknown;
  let sawError = false;

  for (let depth = 0; current !== null && depth < MAX_CHAIN_DEPTH; depth += 1) {
    const channel: ChannelRow = current;
    if (visited.has(channel.id)) break;
    visited.add(channel.id);

    if (channel.status === 'off') {
      attempts.push({ channelId: channel.id, error: 'channel status: off' });
    } else {
      try {
        const value = await attempt(channel);
        attempts.push({ channelId: channel.id });
        return { value, channelId: channel.id, attempts };
      } catch (err) {
        attempts.push({
          channelId: channel.id,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!isRetryableError(err)) throw err;
        lastError = err;
        sawError = true;
      }
    }

    const nextId = channel.fallbackTo;
    current = nextId === null || visited.has(nextId) ? null : await resolve(nextId);
  }

  if (sawError) throw lastError;
  throw new Error(
    `no usable channel in fallback chain starting at ${start.id} (${attempts.length} considered)`,
  );
}

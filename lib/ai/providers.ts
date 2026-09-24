/**
 * The wire protocols a channel or credential can speak.
 *
 * `anthropic` is the first party: one well-known host, reached with the key
 * Anthropic issued. The `*_compatible` kinds name a *protocol*, not a vendor —
 * they point at any gateway implementing it, whether that is a relay, a proxy,
 * an aggregator or a self-hosted model. The upstream is chosen by base URL, so
 * "who wrote the API" and "who serves it" are separate questions.
 *
 * Keeping the compatible kinds distinct from `anthropic` is deliberate. It is
 * what lets `anthropic` keep its fixed endpoint and its `ANTHROPIC_API_KEY`
 * fallback, and — because credentials are looked up by provider *and* base URL
 * — what stops a relay key from ever being offered to api.anthropic.com.
 *
 * The two OpenAI kinds differ by endpoint, not by vendor: `openai_compatible`
 * posts to `/chat/completions`, `openai_responses` to `/responses`. A gateway
 * serving only the Responses API — kie.ai's `/codex/v1` is one — cannot be
 * reached by the chat-completions kind at all, and the request bodies are not
 * interchangeable (`input` items vs `messages`). Naming them separately is
 * what lets one base URL host each without guessing.
 *
 * `kie_jobs` is the one kind that is not a chat protocol at all: it is an
 * asynchronous job queue that returns a task id and delivers the result
 * minutes later. It is named for its vendor rather than a protocol because
 * there is no second implementer to abstract over, and it is unreachable
 * through `buildAI` by design — see the throw there.
 *
 * Dependency-free on purpose: client components import this for their provider
 * pickers, so it must not drag in the AI SDK, zod or anything server-only.
 */
export const PROVIDERS = [
  'anthropic',
  'anthropic_compatible',
  'openai_compatible',
  'openai_responses',
  'kie_jobs',
  'openai_images',
] as const;

export type Provider = (typeof PROVIDERS)[number];

/** Display names. The stored values are snake_case; these are for humans. */
export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  anthropic_compatible: 'Anthropic-compatible',
  openai_compatible: 'OpenAI-compatible',
  openai_responses: 'OpenAI Responses',
  kie_jobs: 'Async media jobs',
  openai_images: 'OpenAI-compatible Images',
};

/**
 * The path each kind appends to its base URL.
 *
 * Exported so the credential forms can state the resulting endpoint instead of
 * leaving the user to infer it: the same host often serves `/chat/completions`
 * and `/responses` under one base URL, and picking the wrong kind fails as a
 * 404 at generation time rather than at save time. Mirrors the routing in
 * `buildAI`; the Anthropic kinds differ by host, not by path.
 */
export const PROVIDER_ENDPOINT_PATH: Record<Provider, string> = {
  anthropic: '/messages',
  anthropic_compatible: '/messages',
  openai_compatible: '/chat/completions',
  openai_responses: '/responses',
  kie_jobs: '/jobs/createTask',
  openai_images: '/images/generations',
};

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Whether this provider's upstream is chosen by base URL.
 *
 * True for both compatible kinds: a gateway is nothing without its host.
 * False for `anthropic`, where a base URL is worse than unnecessary — it is
 * inert, because `buildAI` builds the first-party client without one.
 */
export function requiresBaseUrl(provider: Provider): boolean {
  return provider !== 'anthropic';
}

/**
 * Whether a base URL may be stored against this provider at all.
 *
 * Mirrors {@link requiresBaseUrl} today, and is kept separate because the two
 * answer different questions: one guards an omission, the other guards a value
 * that would silently do nothing.
 */
export function acceptsBaseUrl(provider: Provider): boolean {
  return provider !== 'anthropic';
}

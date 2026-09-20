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
 * Dependency-free on purpose: client components import this for their provider
 * pickers, so it must not drag in the AI SDK, zod or anything server-only.
 */
export const PROVIDERS = ['anthropic', 'anthropic_compatible', 'openai_compatible'] as const;

export type Provider = (typeof PROVIDERS)[number];

/** Display names. The stored values are snake_case; these are for humans. */
export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  anthropic_compatible: 'Anthropic-compatible',
  openai_compatible: 'OpenAI-compatible',
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

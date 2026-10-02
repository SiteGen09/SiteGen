/**
 * gensite-v1: the gateway's own routed model.
 *
 * It is not a model of its own. Each request is sent to whichever public model
 * on the platform suits it best (see {@link chooseTier}), with the gateway's
 * server-side tools layered on top, and it is billed at the rates of the model
 * that actually served it. The tier lists below are that choice, best first;
 * the first model that resolves to a usable channel serves the request and the
 * rest are its fallbacks.
 *
 * Any list can be replaced without a code change through
 * `GENSITE_TIER_<TIER>` (comma-separated public model ids), so a model that
 * disappoints or a new release is one environment edit and a restart away.
 */
export const GENSITE_MODEL_ID = 'gensite-v1';

export type GensiteTier = 'fast' | 'balanced' | 'coder' | 'max' | 'vision' | 'long';

export const GENSITE_TIERS: readonly GensiteTier[] = ['fast', 'balanced', 'coder', 'max', 'vision', 'long'];

// No Claude model appears here: the only Claude channels on the platform come
// from a provider whose Claude models failed verification (see
// DEFAULT_EXCLUSIONS). Add genuine ones back through the environment.
const DEFAULT_TIERS: Record<GensiteTier, readonly string[]> = {
  // Short chat and small helper calls: time to first token matters most.
  fast: ['gemini-3.8-flash', 'gpt-6-luna', 'gemini-3-6-flash-openai', 'deepseek-v4.1-flash'],
  // Everyday questions and writing without an agent loop.
  // GPT-6.1 Sol follows GPT-6 Sol until it has been compared against it. Relay
  // and Kie name it differently, so both names are listed to keep both routes.
  balanced: ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-1-sol', 'gemini-3.1-pro', 'gpt-5.6-sol', 'kimi-k3'],
  // Agent turns (the client sent tools) and code: the strongest coders.
  coder: ['gpt-6-astra', 'gemini-3.1-pro', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-1-sol', 'kimi-k3'],
  // The client asked for the highest reasoning effort.
  max: ['gpt-6-astra', 'gemini-3.1-pro', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-1-sol'],
  // Images attached and no agent loop.
  vision: ['gemini-3.1-pro', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-1-sol', 'gpt-6-astra'],
  // Prompts too large for the others' comfort: million-token windows first.
  long: ['gemini-3.1-pro', 'gpt-6-astra', 'kimi-k3'],
};

function envList(name: string): string[] | null {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return null;
  const ids = raw.split(',').map((id) => id.trim()).filter((id) => id.length > 0 && id !== GENSITE_MODEL_ID);
  return ids;
}

/** The candidate public models for a tier, best first. */
export function tierModels(tier: GensiteTier): readonly string[] {
  const configured = envList(`GENSITE_TIER_${tier.toUpperCase()}`);
  return configured !== null && configured.length > 0 ? configured : DEFAULT_TIERS[tier];
}

/**
 * A provider, or one model family at a provider, that gensite-v1 must never
 * route to. `provider` is the internal routing identity (`relay.fast`,
 * `kie.ai`, an upstream hostname); `family` is a public model id prefix such
 * as `claude`, matched as `claude-…`.
 */
export interface RouteExclusion {
  provider: string;
  family?: string;
}

/** Provider A (relay.fast) serves models under Claude names that are not Claude. */
const DEFAULT_EXCLUSIONS = 'relay.fast:claude';

/**
 * `GENSITE_EXCLUDED_PROVIDERS` replaces the default: a comma-separated list of
 * `provider` or `provider:family` entries. Set it to `none` to exclude nothing.
 */
export function routeExclusions(): readonly RouteExclusion[] {
  const raw = process.env.GENSITE_EXCLUDED_PROVIDERS?.trim() || DEFAULT_EXCLUSIONS;
  if (raw.toLowerCase() === 'none') return [];
  return raw.split(',').flatMap((entry) => {
    const [provider, family] = entry.trim().toLowerCase().split(':');
    if (!provider) return [];
    return [family ? { provider, family } : { provider }];
  });
}

export function isExcluded(exclusions: readonly RouteExclusion[], provider: string, model: string): boolean {
  const id = provider.toLowerCase();
  const name = model.toLowerCase();
  return exclusions.some((rule) =>
    rule.provider === id && (rule.family === undefined || name === rule.family || name.startsWith(`${rule.family}-`)));
}

/** Searches one gensite-v1 request may run before it has to answer. */
export const GENSITE_MAX_SEARCHES = 5;

export function isGensiteModel(model: string): boolean {
  return model === GENSITE_MODEL_ID;
}

/**
 * Whether gensite-v1 belongs in a model listing, judged from the public models
 * the caller can already reach: any tier model among them is enough, because
 * every tier falls back to its siblings.
 */
export function gensiteListed(reachableModels: readonly string[]): boolean {
  const reachable = new Set(reachableModels);
  return GENSITE_TIERS.some((tier) => tierModels(tier).some((model) => reachable.has(model)));
}

/**
 * The difficulty classifier (lib/gensite/classify.ts) asks a small model how
 * hard a request is when the routing rules cannot tell. Off by default: on the
 * current providers a one-word verdict takes two to six seconds, which costs
 * more than the better routing saves. `GENSITE_CLASSIFIER=on` enables it;
 * `GENSITE_CLASSIFIER_MODEL` picks the model and `GENSITE_CLASSIFIER_TIMEOUT_MS`
 * the time limit after which the router gives up and uses its safe default.
 */
export function classifierSettings(): { enabled: boolean; model: string; timeoutMs: number } {
  const timeout = Number(process.env.GENSITE_CLASSIFIER_TIMEOUT_MS);
  return {
    enabled: process.env.GENSITE_CLASSIFIER?.trim().toLowerCase() === 'on',
    model: process.env.GENSITE_CLASSIFIER_MODEL?.trim() || 'glm-5.3-flash',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 3_000,
  };
}

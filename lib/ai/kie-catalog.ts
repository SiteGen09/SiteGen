/**
 * kie.ai's catalogue, read from its own `/api/v1/models` endpoint, whose
 * `pricingDesc` is prose written for humans. It is parsed strictly: a model
 * whose price cannot be read with confidence is SKIPPED and reported, never
 * guessed. An invented price bills real money, so a missing row is always the
 * better failure.
 *
 * Shared by the importer (scripts/import-kie-catalog.mts), which creates
 * channels, and the price sync (lib/ai/kie-price-sync.ts), which keeps their
 * prices current. Prices are kie.ai's own, at 1x: the markup lives on the
 * source's `credit_multiplier`.
 *
 * For media the price is the CEILING of everything the description lists,
 * because it funds the hold and a hold must cover the worst case. The true
 * cost is settled afterwards from the upstream's own `creditsConsumed`.
 */

export const KIE_MODELS_URL = 'https://api.kie.ai/api/v1/models';

/** kie.ai's published credit value. Corroborated by every job we have settled. */
export const KIE_USD_PER_CREDIT = 0.005;

/**
 * kie.ai's vendor label to our routing family.
 *
 * Family is model identity, so it follows the vendor rather than the endpoint.
 * Anything unrecognised becomes `other` rather than being dropped: a model
 * whose vendor we cannot name is still routable, it just groups with the rest.
 */
const FAMILY_BY_VENDOR: Record<string, string> = {
  OpenAI: 'gpt',
  Anthropic: 'claude',
  Google: 'gemini',
  Grok: 'grok',
  Qwen: 'qwen',
  ByteDance: 'bytedance',
  Kling: 'kling',
  Wan: 'wan',
  Runway: 'runway',
  Pixverse: 'pixverse',
  Ideogram: 'ideogram',
  'Black Forest Labs': 'flux',
  Topaz: 'topaz',
  Elevenlabs: 'elevenlabs',
  Suno: 'suno',
  Alibaba: 'alibaba',
  // Hailuo is MiniMax's product name; the family already exists.
  Hailuo: 'minimax',
};

export function familyOf(vendor: string): string {
  return FAMILY_BY_VENDOR[vendor] ?? 'other';
}

/** The three kie.ai surfaces, each a separate protocol and base URL. */
export const SURFACES = {
  chat: { base: 'https://api.kie.ai/v1', provider: 'openai_compatible', task: 'chat.completions' },
  image: { base: 'https://api.kie.ai/api/v1', provider: 'kie_jobs', task: 'image.generate' },
  video: { base: 'https://api.kie.ai/api/v1', provider: 'kie_jobs', task: 'video.generate' },
} as const;

export type Kind = keyof typeof SURFACES;

export interface KieModel {
  model: string;
  title: string;
  provider: string;
  taskType: string[];
  /** Null for models kie.ai has not priced publicly. */
  pricingDesc: string | null;
}

/** Which of our kinds a model belongs to, or null when we do not serve it. */
export function kindOf(taskType: string[]): Kind | null {
  if (taskType.includes('Chat')) return 'chat';
  // Video wins over image for dual-capability models: the video price is the
  // higher ceiling, so a job of either shape stays covered by the hold.
  if (taskType.some((t) => t.includes('Video'))) return 'video';
  if (taskType.some((t) => t.includes('Image'))) return 'image';
  return null;
}

/**
 * Only the listed price matters. The "high-tier top-up" sentence describes a
 * discount on buying credits, not a different price per call, and reading it
 * as one would systematically underprice every model.
 */
export function listedPortion(desc: string | null): string {
  if (desc === null) return '';
  const cut = desc.search(/High-tier top-ups|High-tier top-up/i);
  const listed = cut === -1 ? desc : desc.slice(0, cut);
  // Thousands separators otherwise truncate a figure mid-number: "1,430
  // credits" would read as 1, which underprices by three orders of magnitude.
  return listed.replace(/(\d),(\d)/g, '$1$2');
}

/** Credits times their dollar value, without float noise (280 * 0.005 is 1.4000000000000001). */
function creditUsd(credits: number): number {
  return Number((credits * KIE_USD_PER_CREDIT).toPrecision(12));
}

/** Every dollar amount in the text, as numbers. */
export function dollarsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]));
}

/** Every "N credits" figure in the text. */
function creditsIn(text: string): number[] {
  return [...text.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*credits?/gi)].map((m) => Number(m[1]));
}

export interface ChatPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedPerMTok: number;
}

/**
 * Chat prices appear in two orders, both of which occur in the live data:
 *
 *   "Input 400 credits / 1M tokens (≈ $2.00)"           — label first
 *   "87.5 credits (≈ $0.44) per M input tokens"         — figure first
 *
 * Credits are preferred over the dollar figures because they are exact where
 * the dollars are rounded to the cent.
 */
export function parseChat(desc: string | null): ChatPrice | null {
  const text = listedPortion(desc);
  // Backslashes are doubled: these are template literals, where `\s` would
  // collapse to a literal "s" before RegExp ever sees it.
  const labelFirst = (label: string) =>
    new RegExp(`${label}[^0-9$]{0,20}([0-9]+(?:\\.[0-9]+)?)\\s*credits?`, 'i').exec(text);
  const figureFirst = (label: string) =>
    new RegExp(
      // The gap may contain a parenthesised dollar figure — "87.5 credits
      // (≈ $0.44) per M input tokens" — so periods cannot be excluded here.
      // Newlines can, which is what keeps the match inside one sentence.
      `([0-9]+(?:\\.[0-9]+)?)\\s*credits?[^;|\\n]{0,40}?per\\s+M(?:illion)?\\s+${label}`,
      'i',
    ).exec(text);

  const input = labelFirst('input') ?? figureFirst('input');
  const output = labelFirst('output') ?? figureFirst('output');
  if (input !== null && output !== null) {
    const cachedCredits = /cached\s+input[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)\s*credits?/i.exec(text);
    const cachedUsd = /cached\s+input[^;|\n]{0,100}?\$\s?([0-9]+(?:\.[0-9]+)?)/i.exec(text);
    const inputPerMTok = creditUsd(Number(input[1]));
    return {
      inputPerMTok,
      outputPerMTok: creditUsd(Number(output[1])),
      // If Kie does not publish a separate cache rate, bill cache reads at the
      // normal input rate rather than assume an unpriced discount.
      cachedPerMTok: cachedCredits !== null
        ? creditUsd(Number(cachedCredits[1]))
        : cachedUsd !== null ? Number(cachedUsd[1]) : inputPerMTok,
    };
  }
  const inputUsd = /input[^0-9$]{0,30}\$\s?([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  const outputUsd = /output[^0-9$]{0,30}\$\s?([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  if (inputUsd !== null && outputUsd !== null) {
    const cachedUsd = /cached\s+input[^;|\n]{0,100}?\$\s?([0-9]+(?:\.[0-9]+)?)/i.exec(text);
    const inputPerMTok = Number(inputUsd[1]);
    return {
      inputPerMTok,
      outputPerMTok: Number(outputUsd[1]),
      cachedPerMTok: cachedUsd === null ? inputPerMTok : Number(cachedUsd[1]),
    };
  }
  return null;
}

/**
 * Ceiling price for a media model.
 *
 * Per-second pricing is multiplied out to a plausible maximum clip, because a
 * per-second figure alone would hold a fraction of what a real job costs.
 */
export function parseMediaCeiling(desc: string | null, kind: Kind): number | null {
  const text = listedPortion(desc);
  const perSecond = /per\s+second|\/\s?s\b|credits?\/s/i.test(text);

  const dollars = dollarsIn(text);
  const credits = creditsIn(text);
  const fromCredits = credits.map(creditUsd);
  const candidates = [...dollars, ...fromCredits].filter((n) => n > 0 && n < 100);
  if (candidates.length === 0) return null;

  const ceiling = Math.max(...candidates);
  // A per-second price is not a job price. Assume the longest clip these
  // models commonly produce so the hold covers it.
  const MAX_SECONDS = 10;
  return perSecond && kind === 'video' ? ceiling * MAX_SECONDS : ceiling;
}

/** Stable, readable identifiers derived from the upstream model name. */
export function slug(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export interface KieCatalogRow {
  id: string;
  kind: Kind;
  family: string;
  publicModel: string;
  upstreamModel: string;
  label: string;
  vendor: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedPerMTok: number;
  requestPriceUsd: number | null;
}

export interface KieCatalog {
  rows: KieCatalogRow[];
  skipped: { model: string; taskType: string[]; reason: string }[];
  /**
   * Chat models whose parsed credit price disagrees with the dollar figure the
   * same text states: the regexes latched onto the wrong number, which would
   * silently misprice the model, so these must not be trusted.
   */
  mismatched: string[];
}

export async function fetchKieModels(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<KieModel[]> {
  const response = await fetchImpl(KIE_MODELS_URL, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`kie.ai models HTTP ${response.status}`);
  const body = (await response.json()) as { data?: { models?: KieModel[] } };
  const models = body.data?.models;
  if (!Array.isArray(models) || models.length === 0) throw new Error('kie.ai returned no models');
  return models;
}

export function kieCatalogRows(models: KieModel[]): KieCatalog {
  const rows: KieCatalogRow[] = [];
  const skipped: KieCatalog['skipped'] = [];
  for (const model of models) {
    const kind = kindOf(model.taskType);
    if (kind === null) {
      skipped.push({ model: model.model, taskType: model.taskType, reason: 'kind not served' });
      continue;
    }
    const base = {
      kind,
      family: familyOf(model.provider),
      publicModel: model.model,
      upstreamModel: model.model,
      label: model.title.slice(0, 80),
      vendor: slug(model.provider),
    };
    if (kind === 'chat') {
      const price = parseChat(model.pricingDesc);
      if (price === null) {
        skipped.push({ model: model.model, taskType: model.taskType, reason: 'unparsed chat price' });
        continue;
      }
      rows.push({ id: `kie-chat-${slug(model.model)}`, ...base, ...price, requestPriceUsd: null });
      continue;
    }
    const ceiling = parseMediaCeiling(model.pricingDesc, kind);
    if (ceiling === null) {
      skipped.push({ model: model.model, taskType: model.taskType, reason: 'unparsed media price' });
      continue;
    }
    rows.push({
      id: `kie-${kind}-${slug(model.model)}`, ...base,
      inputPerMTok: 0, outputPerMTok: 0, cachedPerMTok: 0, requestPriceUsd: Number(ceiling.toFixed(6)),
    });
  }

  const mismatched: string[] = [];
  for (const row of rows.filter((r) => r.kind === 'chat')) {
    const source = models.find((m) => m.model === row.publicModel);
    const stated = dollarsIn(listedPortion(source?.pricingDesc ?? null));
    if (stated.length < 2) continue;
    const near = (value: number) => stated.some((d) => Math.abs(d - value) <= d * 0.05 + 0.001);
    if (!near(row.inputPerMTok) || !near(row.outputPerMTok)) {
      mismatched.push(
        `${row.publicModel}: parsed in $${row.inputPerMTok} out $${row.outputPerMTok}, ` +
          `text states ${stated.map((d) => `$${d}`).join(', ')}`,
      );
    }
  }
  return { rows, skipped, mismatched };
}

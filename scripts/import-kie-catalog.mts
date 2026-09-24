/**
 * Imports the kie.ai catalogue into `sources` and `channels`.
 *
 * Prices come from kie.ai's own `/api/v1/models` endpoint, whose `pricingDesc`
 * is prose written for humans. It is parsed strictly: a model whose price
 * cannot be read with confidence is SKIPPED and reported, never guessed. An
 * invented price bills real money, so a missing row is always the better
 * failure.
 *
 * Stored prices are kie.ai's own, at 1x. The markup lives on the source's
 * `credit_multiplier` and is applied at settlement by `creditsForUsage`, so
 * writing marked-up prices here would charge the markup twice.
 *
 * For media, the stored price is the CEILING of everything the description
 * lists, because it funds the hold and a hold must cover the worst case: a
 * ten-second 4K video costs several times a four-second 720p one from the same
 * model. The true cost is settled afterwards from the upstream's own
 * `creditsConsumed`, so the ceiling never becomes the charge.
 *
 *   KIE_API_KEY=... npx tsx scripts/import-kie-catalog.mts [--apply]
 *
 * Without --apply it prints what it would do and writes nothing.
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import postgres from 'postgres';

const APPLY = process.argv.includes('--apply');
const apiKey = process.env.KIE_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  console.error('KIE_API_KEY is required');
  process.exit(1);
}

/** kie.ai's published credit value. Corroborated by every job we have settled. */
const USD_PER_CREDIT = 0.005;

/** Our markup, applied once, on the source. */
const CREDIT_MULTIPLIER = 1.5;

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

function familyOf(vendor: string): string {
  return FAMILY_BY_VENDOR[vendor] ?? 'other';
}

/**
 * One source per family AND modality.
 *
 * Both halves are needed: a routing preference is keyed on the pair, so a
 * single "kie.ai" source per family would make choosing an image gateway
 * silently repoint chat at it.
 */
function sourceIdFor(family: string, kind: Kind): string {
  return `kie-${family}-${kind}`;
}

/** The three kie.ai surfaces, each a separate protocol and base URL. */
const SURFACES = {
  chat: { base: 'https://api.kie.ai/v1', provider: 'openai_compatible', task: 'chat.completions' },
  image: { base: 'https://api.kie.ai/api/v1', provider: 'kie_jobs', task: 'image.generate' },
  video: { base: 'https://api.kie.ai/api/v1', provider: 'kie_jobs', task: 'video.generate' },
} as const;

type Kind = keyof typeof SURFACES;

interface KieModel {
  model: string;
  title: string;
  provider: string;
  taskType: string[];
  /** Null for models kie.ai has not priced publicly. */
  pricingDesc: string | null;
}

/** Which of our kinds a model belongs to, or null when we do not serve it. */
function kindOf(taskType: string[]): Kind | null {
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
function listedPortion(desc: string | null): string {
  if (desc === null) return '';
  const cut = desc.search(/High-tier top-ups|High-tier top-up/i);
  const listed = cut === -1 ? desc : desc.slice(0, cut);
  // Thousands separators otherwise truncate a figure mid-number: "1,430
  // credits" would read as 1, which underprices by three orders of magnitude.
  return listed.replace(/(\d),(\d)/g, '$1$2');
}

/** Every dollar amount in the text, as numbers. */
function dollarsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]));
}

/** Every "N credits" figure in the text. */
function creditsIn(text: string): number[] {
  return [...text.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*credits?/gi)].map((m) => Number(m[1]));
}

interface ChatPrice {
  inputPerMTok: number;
  outputPerMTok: number;
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
function parseChat(desc: string | null): ChatPrice | null {
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
    return {
      inputPerMTok: Number(input[1]) * USD_PER_CREDIT,
      outputPerMTok: Number(output[1]) * USD_PER_CREDIT,
    };
  }
  const inputUsd = /input[^0-9$]{0,30}\$\s?([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  const outputUsd = /output[^0-9$]{0,30}\$\s?([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  if (inputUsd !== null && outputUsd !== null) {
    return { inputPerMTok: Number(inputUsd[1]), outputPerMTok: Number(outputUsd[1]) };
  }
  return null;
}

/**
 * Ceiling price for a media model.
 *
 * Per-second pricing is multiplied out to a plausible maximum clip, because a
 * per-second figure alone would hold a fraction of what a real job costs.
 */
function parseMediaCeiling(desc: string | null, kind: Kind): number | null {
  const text = listedPortion(desc);
  const perSecond = /per\s+second|\/\s?s\b|credits?\/s/i.test(text);

  const dollars = dollarsIn(text);
  const credits = creditsIn(text);
  const fromCredits = credits.map((c) => c * USD_PER_CREDIT);
  const candidates = [...dollars, ...fromCredits].filter((n) => n > 0 && n < 100);
  if (candidates.length === 0) return null;

  const ceiling = Math.max(...candidates);
  // A per-second price is not a job price. Assume the longest clip these
  // models commonly produce so the hold covers it.
  const MAX_SECONDS = 10;
  return perSecond && kind === 'video' ? ceiling * MAX_SECONDS : ceiling;
}

/** Stable, readable identifiers derived from the upstream model name. */
function slug(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

const response = await fetch('https://api.kie.ai/api/v1/models', {
  headers: { authorization: `Bearer ${apiKey}` },
});
const body = (await response.json()) as { data: { models: KieModel[] } };
const models = body.data.models;
console.log(`fetched ${models.length} models from kie.ai\n`);

interface Row {
  id: string;
  kind: Kind;
  family: string;
  publicModel: string;
  upstreamModel: string;
  label: string;
  vendor: string;
  inputPerMTok: number;
  outputPerMTok: number;
  requestPriceUsd: number | null;
}

const rows: Row[] = [];
const skipped: { model: string; taskType: string[]; reason: string }[] = [];

for (const model of models) {
  const kind = kindOf(model.taskType);
  if (kind === null) {
    skipped.push({ model: model.model, taskType: model.taskType, reason: 'kind not served' });
    continue;
  }

  if (kind === 'chat') {
    const price = parseChat(model.pricingDesc);
    if (price === null) {
      skipped.push({ model: model.model, taskType: model.taskType, reason: 'unparsed chat price' });
      continue;
    }
    rows.push({
      id: `kie-chat-${slug(model.model)}`,
      kind,
      family: familyOf(model.provider),
      publicModel: model.model,
      upstreamModel: model.model,
      label: model.title.slice(0, 80),
      vendor: slug(model.provider),
      inputPerMTok: price.inputPerMTok,
      outputPerMTok: price.outputPerMTok,
      requestPriceUsd: null,
    });
    continue;
  }

  const ceiling = parseMediaCeiling(model.pricingDesc, kind);
  if (ceiling === null) {
    skipped.push({ model: model.model, taskType: model.taskType, reason: 'unparsed media price' });
    continue;
  }
  rows.push({
    id: `kie-${kind}-${slug(model.model)}`,
    kind,
    family: familyOf(model.provider),
    publicModel: model.model,
    upstreamModel: model.model,
    label: model.title.slice(0, 80),
    vendor: slug(model.provider),
    inputPerMTok: 0,
    outputPerMTok: 0,
    requestPriceUsd: Number(ceiling.toFixed(6)),
  });
}

const byKind = (k: Kind) => rows.filter((r) => r.kind === k);
for (const kind of ['chat', 'image', 'video'] as const) {
  const list = byKind(kind);
  console.log(`${kind}: ${list.length} models`);
  for (const row of list.slice(0, 3)) {
    console.log(
      `  ${row.publicModel} -> ` +
        (kind === 'chat'
          ? `in $${row.inputPerMTok}/Mtok out $${row.outputPerMTok}/Mtok`
          : `ceiling $${row.requestPriceUsd}`),
    );
  }
  if (list.length > 3) console.log(`  … and ${list.length - 3} more`);
}

/**
 * Cross-check: kie.ai states both a credit figure and a dollar figure for
 * chat models, and they must agree once converted. A mismatch means the
 * regexes latched onto the wrong number — the failure mode that would
 * silently misprice the catalogue, so it is reported rather than trusted.
 */
const mismatched: string[] = [];
for (const row of byKind('chat')) {
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
console.log(
  `\ncredit/dollar cross-check: ${byKind('chat').length - mismatched.length}/${byKind('chat').length} chat models agree`,
);
for (const line of mismatched) console.log(`  ! ${line}`);

console.log(`\nskipped ${skipped.length}:`);
const reasons = new Map<string, number>();
for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
for (const [reason, count] of reasons) console.log(`  ${reason}: ${count}`);
for (const s of skipped.filter((x) => x.reason !== 'kind not served')) {
  console.log(`  ! ${s.model} (${s.taskType.join(', ')})`);
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to write these rows.');
  process.exit(0);
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

// One source per (family, modality) actually present in the catalogue. The
// first source for a pair becomes its default, since a pair with no default
// falls through to "any eligible source" and loses the cascade.
const pairs = new Map<string, { family: string; kind: Kind }>();
for (const row of rows) pairs.set(sourceIdFor(row.family, row.kind), { family: row.family, kind: row.kind });

const defaulted = new Set<string>();
for (const [id, { family, kind }] of pairs) {
  const pairKey = `${family}:${kind}`;
  const isDefault = !defaulted.has(pairKey);
  defaulted.add(pairKey);
  await sql`
    INSERT INTO sources (id, family, modality, label, description, credit_multiplier, status, min_plan, is_default)
    VALUES (${id}, ${family}, ${kind}, ${`kie.ai ${family} ${kind}`},
            ${`kie.ai ${kind} models from ${family}`}, ${CREDIT_MULTIPLIER}, 'active', 'free', ${isDefault})
    ON CONFLICT (id) DO UPDATE SET
      family = EXCLUDED.family,
      modality = EXCLUDED.modality,
      label = EXCLUDED.label,
      credit_multiplier = EXCLUDED.credit_multiplier`;
}
console.log(`
sources: ${pairs.size} (family x modality)`);

let written = 0;
for (const row of rows) {
  const surface = SURFACES[row.kind];
  await sql`
    INSERT INTO channels (
      id, label, task, provider, base_url, model_id, source_id, public_model_id, vendor,
      pricing_type, request_price_usd, input_per_mtok, output_per_mtok, cached_per_mtok,
      list_input_per_mtok, list_output_per_mtok, status, min_plan, priority
    ) VALUES (
      ${row.id}, ${row.label}, ${surface.task}, ${surface.provider}, ${surface.base},
      ${row.upstreamModel}, ${sourceIdFor(row.family, row.kind)}, ${row.publicModel}, ${row.vendor},
      ${row.kind === 'chat' ? 'token' : 'request'}, ${row.requestPriceUsd},
      ${row.inputPerMTok}, ${row.outputPerMTok}, 0,
      ${row.inputPerMTok}, ${row.outputPerMTok}, 'active', 'free', 0
    )
    ON CONFLICT (id) DO UPDATE SET
      label = EXCLUDED.label,
      task = EXCLUDED.task,
      provider = EXCLUDED.provider,
      base_url = EXCLUDED.base_url,
      model_id = EXCLUDED.model_id,
      source_id = EXCLUDED.source_id,
      public_model_id = EXCLUDED.public_model_id,
      vendor = EXCLUDED.vendor,
      pricing_type = EXCLUDED.pricing_type,
      request_price_usd = EXCLUDED.request_price_usd,
      input_per_mtok = EXCLUDED.input_per_mtok,
      output_per_mtok = EXCLUDED.output_per_mtok,
      list_input_per_mtok = EXCLUDED.list_input_per_mtok,
      list_output_per_mtok = EXCLUDED.list_output_per_mtok,
      updated_at = now()`;
  written += 1;
}

console.log(`wrote ${written} channels across ${pairs.size} sources`);
await sql.end();

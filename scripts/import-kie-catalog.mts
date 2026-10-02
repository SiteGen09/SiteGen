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
import { fetchKieModels, kieCatalogRows, SURFACES, type Kind } from '../lib/ai/kie-catalog';

const APPLY = process.argv.includes('--apply');
const apiKey = process.env.KIE_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  console.error('KIE_API_KEY is required');
  process.exit(1);
}

/** Our markup, applied once, on the source. */
const CREDIT_MULTIPLIER = 1.5;

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

const models = await fetchKieModels(apiKey);
console.log(`fetched ${models.length} models from kie.ai\n`);
const { rows, skipped, mismatched } = kieCatalogRows(models);

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

// Parsed credit prices that disagree with the stated dollar figure (see kieCatalogRows).
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
      list_input_per_mtok, list_output_per_mtok, list_cached_per_mtok, status, min_plan, priority
    ) VALUES (
      ${row.id}, ${row.label}, ${surface.task}, ${surface.provider}, ${surface.base},
      ${row.upstreamModel}, ${sourceIdFor(row.family, row.kind)}, ${row.publicModel}, ${row.vendor},
      ${row.kind === 'chat' ? 'token' : 'request'}, ${row.requestPriceUsd},
      ${row.inputPerMTok}, ${row.outputPerMTok}, ${row.cachedPerMTok},
      ${row.inputPerMTok}, ${row.outputPerMTok}, ${row.cachedPerMTok}, 'active', 'free', 0
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
      cached_per_mtok = EXCLUDED.cached_per_mtok,
      list_input_per_mtok = EXCLUDED.list_input_per_mtok,
      list_output_per_mtok = EXCLUDED.list_output_per_mtok,
      list_cached_per_mtok = EXCLUDED.list_cached_per_mtok,
      updated_at = now()`;
  written += 1;
}

console.log(`wrote ${written} channels across ${pairs.size} sources`);
await sql.end();

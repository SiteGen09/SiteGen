/**
 * Add GPT-6.1 Sol from Relay.fast (`gpt-6.1-sol`) and Kie.ai Responses (`gpt-6-1-sol`),
 * using each provider's live published rates. Both were probed live before this ran.
 *
 * Dry run by default; --apply writes.
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });
import postgres from 'postgres';
import { billingPolicySchema, scaleTiers } from '../lib/ai/billing-policy';
import { fetchKieModels, kieCatalogRows } from '../lib/ai/kie-catalog';
import { relayChannels, RELAY_BASE_URL } from '../lib/ai/relay-catalog';

const APPLY = process.argv.includes('--apply');
const relayKey = process.env.RELAY_API_KEY;
const kieKey = process.env.KIE_API_KEY;
if (!relayKey || !kieKey) throw new Error('RELAY_API_KEY and KIE_API_KEY are required');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const KIE_BASE_URL = 'https://api.kie.ai/codex/v1';
const RELAY_MODEL = 'gpt-6.1-sol';
const KIE_MODEL = 'gpt-6-1-sol';

// Relay: live catalog rates, and the key must see the model.
const [pricingResponse, relayModelsResponse, kieModelsResponse] = await Promise.all([
  fetch('https://relay.fast/api/pricing', { signal: AbortSignal.timeout(30_000) }),
  fetch(`${RELAY_BASE_URL}/models`, { headers: { authorization: `Bearer ${relayKey}` }, signal: AbortSignal.timeout(30_000) }),
  fetch(`${KIE_BASE_URL}/models`, { headers: { authorization: `Bearer ${kieKey}` }, signal: AbortSignal.timeout(30_000) }),
]);
if (!pricingResponse.ok) throw new Error(`Relay pricing catalog HTTP ${pricingResponse.status}`);
if (!relayModelsResponse.ok) throw new Error(`Relay model access check HTTP ${relayModelsResponse.status}`);
if (!kieModelsResponse.ok) throw new Error(`Kie Responses model list HTTP ${kieModelsResponse.status}`);
const catalog = await pricingResponse.json() as { data: { model_name: string }[] };
const relayRoute = relayChannels({ ...catalog, data: catalog.data.filter((m) => m.model_name === RELAY_MODEL) })[0];
if (!relayRoute) throw new Error('Relay pricing catalog does not list ' + RELAY_MODEL);
if (!(await relayModelsResponse.json() as { data?: { id: string }[] }).data?.some((m) => m.id === RELAY_MODEL)) {
  throw new Error('Relay key cannot access ' + RELAY_MODEL);
}
if (relayRoute.source_id !== 'relay-gpt-chat' || relayRoute.modality !== 'chat') throw new Error('Unexpected Relay family for ' + RELAY_MODEL);

// Kie: the strict catalog parser's price, and the Responses surface must list the model.
if (!(await kieModelsResponse.json() as { data?: { id: string }[] }).data?.some((m) => m.id === KIE_MODEL)) {
  throw new Error('Kie Responses surface does not list ' + KIE_MODEL);
}
const kieModel = (await fetchKieModels(kieKey)).find((m) => m.model === KIE_MODEL);
const { rows: kieRows, mismatched } = kieCatalogRows(kieModel ? [kieModel] : []);
const kieRow = kieRows[0];
if (!kieRow || kieRow.kind !== 'chat' || mismatched.length) throw new Error('Kie price for ' + KIE_MODEL + ' did not parse cleanly');
// Cache writes are listed but not part of the parsed chat price; read them the same strict way.
const cacheWrite = /Cache Writes\s+(\d+(?:\.\d+)?)\s+credits\s*\/\s*1M tokens\s*\(≈\s*\$([0-9.]+)\)/.exec(kieModel!.pricingDesc ?? '');
if (!cacheWrite || Number(cacheWrite[1]) * 0.005 !== Number(cacheWrite[2])) throw new Error('Kie cache-write price for ' + KIE_MODEL + ' did not parse');

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  await sql.begin(async (tx) => {
    const sources = await tx`
      SELECT id, credit_multiplier FROM sources
      WHERE id IN ('relay-gpt-chat', 'kie-gpt-chat') AND family = 'gpt' AND modality = 'chat' AND status = 'active'`;
    if (sources.length !== 2) throw new Error('Expected active relay-gpt-chat and kie-gpt-chat sources');
    for (const [provider, baseUrl] of [['openai_compatible', RELAY_BASE_URL], ['openai_responses', KIE_BASE_URL]] as const) {
      const credential = await tx`
        SELECT id FROM provider_credentials
        WHERE owner_id IS NULL AND provider = ${provider} AND base_url = ${baseUrl} AND status = 'active'`;
      if (credential.length !== 1) throw new Error(`Expected one active ${provider} credential for ${baseUrl}`);
    }

    // Price the Relay row at the source tier its GPT siblings are synced to
    // (lib/ai/relay-sources.ts); the catalog default would undercharge until the next sync.
    const siblings = await tx`
      SELECT DISTINCT (billing_policy->'sourcePricing'->>'scale')::numeric AS scale,
        billing_policy->'sourcePricing'->>'tier' AS tier, billing_policy->'sourcePricing'->>'label' AS label FROM channels
      WHERE source_id = 'relay-gpt-chat' AND id LIKE 'relay-%' AND status = 'active'`;
    if (siblings.length !== 1) throw new Error('Relay GPT rows disagree on their synced source tier');
    const synced = siblings[0]!;
    if (!synced.tier || !(Number(synced.scale) > 0)) throw new Error('Relay GPT rows have no synced source tier');
    const sourcePricing = { ...relayRoute.billing_policy.sourcePricing!, scale: Number(synced.scale), tier: synced.tier as string, label: synced.label as string | null };
    const tiers = scaleTiers(sourcePricing.baseTiers, sourcePricing.scale);
    const { family: _family, modality: _modality, ...relayRow } = {
      ...relayRoute,
      billing_policy: billingPolicySchema.parse({ ...relayRoute.billing_policy, tiers, sourcePricing }),
      input_per_mtok: tiers[0]!.rates.inputPerMTok,
      output_per_mtok: tiers[0]!.rates.outputPerMTok,
      cached_per_mtok: tiers[0]!.rates.cachedPerMTok,
    };

    const kieInsert = {
      id: kieRow.id, label: 'GPT-6.1 Sol', task: 'chat.completions', provider: 'openai_responses',
      base_url: KIE_BASE_URL, model_id: KIE_MODEL, public_model_id: KIE_MODEL, source_id: 'kie-gpt-chat',
      vendor: 'openai', pricing_type: 'token',
      input_per_mtok: kieRow.inputPerMTok, cached_per_mtok: kieRow.cachedPerMTok, output_per_mtok: kieRow.outputPerMTok,
      list_input_per_mtok: kieRow.inputPerMTok, list_cached_per_mtok: kieRow.cachedPerMTok, list_output_per_mtok: kieRow.outputPerMTok,
      billing_policy: billingPolicySchema.parse({
        origin: 'kie.ai', version: 'catalog-2026-09-30', syncedAt: new Date().toISOString(),
        tiers: [{ name: 'standard', rates: {
          inputPerMTok: kieRow.inputPerMTok, outputPerMTok: kieRow.outputPerMTok,
          cachedPerMTok: kieRow.cachedPerMTok, cacheWritePerMTok: Number(cacheWrite[2]),
        } }],
      }),
    };

    console.table([relayRow, kieInsert].map((r) => ({
      id: r.id, model: r.model_id, source: r.source_id, input: r.input_per_mtok, output: r.output_per_mtok, cached: r.cached_per_mtok,
    })));
    if (!APPLY) return;

    for (const row of [relayRow, kieInsert]) {
      const existing = await tx`SELECT provider, base_url, model_id, source_id FROM channels WHERE id = ${row.id}`;
      if (existing.length > 0 && (existing[0]!.provider !== row.provider || existing[0]!.base_url !== row.base_url ||
        existing[0]!.model_id !== row.model_id || existing[0]!.source_id !== row.source_id)) {
        throw new Error('Refusing to overwrite conflicting channel ' + row.id);
      }
    }
    // Same fallback priority as the sibling routes: adding a model must not change a default.
    const relayPriority = (await tx`SELECT priority FROM channels WHERE id = 'relay-gpt-6-sol'`)[0]?.priority ?? -1;
    for (const [row, priority] of [[relayRow, relayPriority], [kieInsert, 0]] as const) {
      await tx`
        INSERT INTO channels ${tx({ ...row, billing_policy: tx.json(row.billing_policy), status: 'active', min_plan: 'free', priority })}
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label, public_model_id = EXCLUDED.public_model_id, vendor = EXCLUDED.vendor,
          pricing_type = EXCLUDED.pricing_type,
          input_per_mtok = EXCLUDED.input_per_mtok, output_per_mtok = EXCLUDED.output_per_mtok,
          cached_per_mtok = EXCLUDED.cached_per_mtok,
          list_input_per_mtok = EXCLUDED.list_input_per_mtok, list_output_per_mtok = EXCLUDED.list_output_per_mtok,
          list_cached_per_mtok = EXCLUDED.list_cached_per_mtok, billing_policy = EXCLUDED.billing_policy,
          updated_at = now()`;
    }
  });
  console.log(APPLY ? 'Added/updated GPT-6.1 Sol on Relay.fast and Kie.ai.' : 'Dry run. Re-run with --apply to write these rows.');
} finally {
  await sql.end();
}

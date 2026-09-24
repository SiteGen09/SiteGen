/** Add Claude Opus 5.5 from Relay.fast, using its live published rates. */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });
import postgres from 'postgres';
import { relayChannels, RELAY_BASE_URL } from '../lib/ai/relay-catalog';

const apiKey = process.env.RELAY_API_KEY;
if (!apiKey) throw new Error('RELAY_API_KEY is required');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const modelId = 'claude-opus-5-5';
const [pricingResponse, modelsResponse] = await Promise.all([
  fetch('https://relay.fast/api/pricing', { signal: AbortSignal.timeout(30_000) }),
  fetch(`${RELAY_BASE_URL}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  }),
]);
if (!pricingResponse.ok) throw new Error(`Relay pricing catalog HTTP ${pricingResponse.status}`);
if (!modelsResponse.ok) throw new Error(`Relay model access check HTTP ${modelsResponse.status}`);
const [catalog, modelList] = await Promise.all([pricingResponse.json(), modelsResponse.json()]);
const route = relayChannels(catalog).find((channel) => channel.model_id === modelId);
if (!route) throw new Error('Relay pricing catalog does not list ' + modelId);
const available = (modelList as { data?: { id: string }[] }).data?.some((model) => model.id === modelId);
if (!available) throw new Error('Relay key cannot access ' + modelId);
if (route.source_id !== 'relay-claude-chat' || route.modality !== 'chat') {
  throw new Error('Unexpected Relay family or modality for ' + modelId);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  await sql.begin(async (tx) => {
    const source = await tx`
      SELECT id, credit_multiplier FROM sources
      WHERE id = 'relay-claude-chat' AND family = 'claude' AND modality = 'chat'
        AND status = 'active'`;
    if (source.length !== 1 || Number(source[0]!.credit_multiplier) !== 1.5) {
      throw new Error('Expected active Relay Claude chat source with 1.5x markup');
    }
    const credential = await tx`
      SELECT id FROM provider_credentials
      WHERE owner_id IS NULL AND provider = 'openai_compatible'
        AND base_url = ${RELAY_BASE_URL} AND status = 'active'`;
    if (credential.length !== 1) throw new Error('Expected one active Relay chat credential');

    const existing = await tx`
      SELECT provider, base_url, model_id, source_id FROM channels
      WHERE id = 'relay-claude-opus-5-5'`;
    if (existing.length > 0 && (
      existing[0]!.provider !== route.provider || existing[0]!.base_url !== route.base_url ||
      existing[0]!.model_id !== route.model_id || existing[0]!.source_id !== route.source_id
    )) throw new Error('Refusing to overwrite a conflicting Relay Opus channel');

    const priorityRows = await tx`
      SELECT COALESCE(MIN(priority), 0) - 1 AS priority
      FROM channels WHERE id LIKE 'relay-%'`;
    const priority = priorityRows[0]!.priority;
    const { family: _family, modality: _modality, ...row } = route;
    await tx`
      INSERT INTO channels ${tx({
        ...row,
        billing_policy: tx.json(row.billing_policy),
        status: 'active',
        min_plan: 'free',
        priority,
      })}
      ON CONFLICT (id) DO UPDATE SET
        label = EXCLUDED.label, model_id = EXCLUDED.model_id,
        public_model_id = EXCLUDED.public_model_id, vendor = EXCLUDED.vendor,
        pricing_type = EXCLUDED.pricing_type, request_price_usd = EXCLUDED.request_price_usd,
        input_per_mtok = EXCLUDED.input_per_mtok, output_per_mtok = EXCLUDED.output_per_mtok,
        cached_per_mtok = EXCLUDED.cached_per_mtok,
        list_input_per_mtok = EXCLUDED.list_input_per_mtok,
        list_output_per_mtok = EXCLUDED.list_output_per_mtok,
        list_cached_per_mtok = EXCLUDED.list_cached_per_mtok,
        billing_policy = EXCLUDED.billing_policy, context_window = EXCLUDED.context_window,
        endpoints = EXCLUDED.endpoints, tags = EXCLUDED.tags, updated_at = now()`;
  });
  console.log('Added/updated Relay.fast ' + modelId + ' with live catalog rates; existing source markup and fallback priority retained.');
} finally {
  await sql.end();
}

/** Add the requested Kie.ai Responses models and encrypted platform key. */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });
import postgres from 'postgres';
import { encryptSecret } from '../lib/crypto/aes';

const BASE_URL = 'https://api.kie.ai/codex/v1';
const PROVIDER = 'openai_responses';
const MULTIPLIER = 1.5;
const apiKey = process.env.KIE_API_KEY;
if (!apiKey) throw new Error('KIE_API_KEY is required');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

interface RequestedModel {
  id: string;
  label: string;
  modelId: string;
  publicModelId: string;
  sourceId: string;
  family: 'gpt' | 'moonshot' | 'deepseek' | 'grok';
  vendor: string;
  input: number;
  cached: number;
  output: number;
  cacheWrite?: number;
}

const models: RequestedModel[] = [
  { id: 'kie-chat-gpt-6-sol', label: 'GPT-6 Sol', modelId: 'gpt-6-sol', publicModelId: 'gpt-6-sol', sourceId: 'kie-gpt-chat', family: 'gpt', vendor: 'openai', input: 0.6, cached: 0.06, output: 3, cacheWrite: 0.75 },
  { id: 'kie-chat-kimi-k3', label: 'Kimi K3', modelId: 'kimi-k3', publicModelId: 'kimi-k3', sourceId: 'kie-moonshot-chat', family: 'moonshot', vendor: 'moonshot', input: 2.4, cached: 0.24, output: 12 },
  { id: 'kie-chat-deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash', modelId: 'deepseek-v4-1-flash', publicModelId: 'deepseek-v4-1-flash', sourceId: 'kie-deepseek-chat', family: 'deepseek', vendor: 'deepseek', input: 0.12, cached: 0.0025, output: 0.475 },
  { id: 'kie-chat-grok-4-7', label: 'Grok 4.7', modelId: 'grok-4-7', publicModelId: 'grok-4-7', sourceId: 'kie-grok-chat', family: 'grok', vendor: 'grok', input: 0.8, cached: 0.2, output: 2.4 },
];

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  await sql.begin(async (tx) => {
    for (const family of ['moonshot', 'deepseek'] as const) {
      const defaults = await tx`
        SELECT id FROM sources
        WHERE family = ${family} AND modality = 'chat' AND is_default`;
      const expected = 'kie-' + family + '-chat';
      if (defaults.some((row) => row.id !== expected)) {
        throw new Error('Refusing to change ' + family + ' default source');
      }
    }

    for (const model of models) {
      const existing = await tx`
        SELECT provider, base_url, model_id, source_id FROM channels WHERE id = ${model.id}`;
      if (existing.length > 0 && (
        existing[0]!.provider !== PROVIDER || existing[0]!.base_url !== BASE_URL ||
        existing[0]!.model_id !== model.modelId || existing[0]!.source_id !== model.sourceId
      )) throw new Error('Refusing to overwrite conflicting channel ' + model.id);
    }

    for (const family of ['moonshot', 'deepseek'] as const) {
      const id = 'kie-' + family + '-chat';
      await tx`
        INSERT INTO sources
          (id, family, modality, label, description, credit_multiplier, status, min_plan, is_default)
        VALUES
          (${id}, ${family}, 'chat', ${'kie.ai ' + family + ' chat'},
           ${'Kie.ai Responses API ' + family + ' chat models'}, ${MULTIPLIER}, 'active', 'free', true)
        ON CONFLICT (id) DO UPDATE SET
          family = EXCLUDED.family, modality = EXCLUDED.modality,
          label = EXCLUDED.label, description = EXCLUDED.description,
          credit_multiplier = EXCLUDED.credit_multiplier, status = 'active',
          min_plan = 'free', is_default = true`;
    }

    for (const model of models) {
      const source = await tx`SELECT id FROM sources WHERE id = ${model.sourceId}`;
      if (source.length !== 1) throw new Error('Expected source ' + model.sourceId + ' to exist');
      await tx`
        INSERT INTO channels (
          id, label, task, provider, base_url, model_id, source_id, public_model_id,
          vendor, pricing_type, input_per_mtok, cached_per_mtok, output_per_mtok,
          list_input_per_mtok, list_cached_per_mtok, list_output_per_mtok,
          billing_policy, status, min_plan, priority
        ) VALUES (
          ${model.id}, ${model.label}, 'chat.completions', ${PROVIDER}, ${BASE_URL},
          ${model.modelId}, ${model.sourceId}, ${model.publicModelId}, ${model.vendor},
          'token', ${model.input}, ${model.cached}, ${model.output},
          ${model.input}, ${model.cached}, ${model.output},
          ${tx.json({
            origin: 'kie.ai',
            version: 'catalog-2026-09-25',
            syncedAt: new Date().toISOString(),
            tiers: [{ name: 'standard', rates: {
              inputPerMTok: model.input,
              outputPerMTok: model.output,
              cachedPerMTok: model.cached,
              ...(model.cacheWrite === undefined ? {} : { cacheWritePerMTok: model.cacheWrite }),
            } }],
          })}, 'active', 'free', 0
        )
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label, task = EXCLUDED.task, provider = EXCLUDED.provider,
          base_url = EXCLUDED.base_url, model_id = EXCLUDED.model_id,
          source_id = EXCLUDED.source_id, public_model_id = EXCLUDED.public_model_id,
          vendor = EXCLUDED.vendor, pricing_type = EXCLUDED.pricing_type,
          input_per_mtok = EXCLUDED.input_per_mtok,
          cached_per_mtok = EXCLUDED.cached_per_mtok,
          output_per_mtok = EXCLUDED.output_per_mtok,
          list_input_per_mtok = EXCLUDED.list_input_per_mtok,
          list_cached_per_mtok = EXCLUDED.list_cached_per_mtok,
          list_output_per_mtok = EXCLUDED.list_output_per_mtok,
          billing_policy = EXCLUDED.billing_policy,
          status = 'active', min_plan = 'free', updated_at = now()`;
    }

    const credentials = await tx`
      SELECT id FROM provider_credentials
      WHERE owner_id IS NULL AND provider = ${PROVIDER}
        AND base_url = ${BASE_URL} AND status = 'active'`;
    if (credentials.length > 1) throw new Error('Multiple active Kie Responses credentials exist');
    if (credentials.length === 0) {
      const { ciphertext, iv, authTag } = encryptSecret(apiKey);
      await tx`
        INSERT INTO provider_credentials
          (owner_id, provider, base_url, ciphertext, iv, auth_tag, last_four, status)
        VALUES (NULL, ${PROVIDER}, ${BASE_URL}, ${ciphertext}, ${iv},
                ${authTag}, ${apiKey.slice(-4)}, 'active')`;
    }
  });
  console.log('Added/updated ' + models.length + ' Kie Responses chat models.');
  for (const model of models) console.log('  ' + model.publicModelId + ' (' + model.family + ')');
} finally {
  await sql.end();
}

/** Dry run by default. --apply imports only relay-* rows and encrypted Relay credentials. */
import { config } from 'dotenv';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { relayChannels, RELAY_BASE_URL } from '../lib/ai/relay-catalog';
import { encryptSecret } from '../lib/crypto/aes';
config({ path: '.env.local', quiet: true });

const key = process.env.RELAY_API_KEY;
if (!key) throw new Error('RELAY_API_KEY is required');
const response = await fetch('https://relay.fast/api/pricing', { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
const channels = relayChannels(await response.json());
// Confirm the supplied key can see the advertised models before activating them.
const modelsResponse = await fetch(`${RELAY_BASE_URL}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
if (!modelsResponse.ok) throw new Error(`Relay key verification HTTP ${modelsResponse.status}`);
const models = await modelsResponse.json() as { data?: { id: string }[] };
const available = new Set(models.data?.map(m => m.id));
const missing = channels.filter(c => !available.has(c.model_id));
if (missing.length) throw new Error(`Key cannot access published models: ${missing.map(c => c.model_id).join(', ')}`);
console.log(`${channels.length} verified Relay models: ${channels.filter(c => c.modality === 'chat').length} chat, ${channels.filter(c => c.modality === 'image').length} image. Markup: 1.5x.`);
if (!process.argv.includes('--apply')) {
  console.table(channels.map(c => ({ model: c.model_id, source: c.source_id, input: c.input_per_mtok, output: c.output_per_mtok, cached: c.cached_per_mtok, tiers: c.billing_policy.tiers.length })));
  process.exit(0);
}
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('relay-catalog-import'))`;
    async function protectedFingerprint() {
      const rows = await tx`SELECT jsonb_build_object(
        'channels', (SELECT jsonb_agg(to_jsonb(c) - 'billing_policy' ORDER BY id) FROM channels c WHERE id NOT LIKE 'relay-%'),
        'sources', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM sources s WHERE id NOT LIKE 'relay-%'),
        'credentials', (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM provider_credentials p WHERE base_url IS DISTINCT FROM ${RELAY_BASE_URL}),
        'preferences', (SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id, family, modality) FROM user_routing_preferences p)
      ) AS snapshot`;
      return createHash('sha256').update(JSON.stringify(rows[0]!.snapshot)).digest('hex');
    }
    const before = await protectedFingerprint();
    const sources = new Map(channels.map(c => [c.source_id, c]));
    for (const [id, c] of sources) {
      await tx`INSERT INTO sources (id, family, modality, label, description, credit_multiplier, is_default)
        VALUES (${id}, ${c.family}, ${c.modality}, 'Relay.fast', 'Relay.fast published pricing, including cache and applicable tiers, plus 50% platform markup.', 1.5, false)
        ON CONFLICT (id) DO NOTHING`;
    }
    // Below every existing route: adding a provider must not change a default.
    const priorityRows = await tx`SELECT COALESCE(MIN(priority),0)-1 AS priority FROM channels WHERE id NOT LIKE 'relay-%'`;
    const priority = priorityRows[0]!.priority;
    for (const c of channels) {
      const { family: _family, modality: _modality, ...row } = c;
      const existing = await tx`SELECT base_url, source_id FROM channels WHERE id = ${row.id}`;
      if (existing.length && (existing[0]!.base_url !== RELAY_BASE_URL || existing[0]!.source_id !== row.source_id)) throw new Error(`Channel collision: ${row.id}`);
      await tx`INSERT INTO channels ${tx({ ...row, billing_policy: tx.json(row.billing_policy), priority })}
        ON CONFLICT (id) DO UPDATE SET
          input_per_mtok = EXCLUDED.input_per_mtok, output_per_mtok = EXCLUDED.output_per_mtok,
          cached_per_mtok = EXCLUDED.cached_per_mtok, request_price_usd = EXCLUDED.request_price_usd,
          list_input_per_mtok = EXCLUDED.list_input_per_mtok, list_output_per_mtok = EXCLUDED.list_output_per_mtok,
          list_cached_per_mtok = EXCLUDED.list_cached_per_mtok, billing_policy = EXCLUDED.billing_policy,
          context_window = EXCLUDED.context_window, tags = EXCLUDED.tags, endpoints = EXCLUDED.endpoints, updated_at = now()`;
    }
    for (const provider of ['openai_compatible', 'openai_images']) {
      const { ciphertext, iv, authTag } = encryptSecret(key);
      const existing = await tx`SELECT id FROM provider_credentials WHERE owner_id IS NULL AND provider = ${provider} AND base_url = ${RELAY_BASE_URL} AND status = 'active'`;
      if (existing.length > 1) throw new Error('Multiple active Relay credentials; resolve before syncing');
      if (existing.length) {
        await tx`UPDATE provider_credentials SET ciphertext=${ciphertext}, iv=${iv}, auth_tag=${authTag}, last_four=${key.slice(-4)} WHERE id=${existing[0]!.id}`;
      } else {
        await tx`INSERT INTO provider_credentials (owner_id, provider, base_url, ciphertext, iv, auth_tag, last_four, status) VALUES (NULL, ${provider}, ${RELAY_BASE_URL}, ${ciphertext}, ${iv}, ${authTag}, ${key.slice(-4)}, 'active')`;
      }
    }
    if (before !== await protectedFingerprint()) throw new Error('Protected configuration changed; import rolled back');
    console.log(`Imported ${channels.length} channels / ${sources.size} sources. Non-Relay channels, sources, credentials and user preferences unchanged.`);
  });
} finally { await sql.end(); }

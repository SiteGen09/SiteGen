/**
 * Seeds the local kie.ai media channels — one image, one video — plus the
 * source they share and the platform credential their dispatch looks up by
 * (provider, base_url).
 *
 * Local development only. The key is read from KIE_API_KEY so it never lands
 * in the repository, and it is encrypted with ENCRYPTION_KEY exactly as the
 * admin UI would store it.
 *
 *   KIE_API_KEY=... npx tsx scripts/seed-media-channels.mts
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import postgres from 'postgres';

import { encryptSecret } from '../lib/crypto/aes';

const BASE_URL = 'https://api.kie.ai/api/v1';
const SOURCE_ID = 'kie-media';

/**
 * Two channels on one source: same gateway, same credential, different task.
 * `selectMediaChannel` matches on task, so the image endpoint can never reach
 * the video model or vice versa.
 *
 * Prices are placeholders. Upstream bills 6 of its own credits for an image;
 * video costs considerably more, hence the gap.
 */
const CHANNELS = [
  {
    id: 'kie-image-flare',
    label: 'Flare text-to-image',
    task: 'image.generate',
    publicModel: 'gpt-image-2-5-flare',
    upstreamModel: 'gpt-image-2-5-flare-text-to-image',
    priceUsd: 0.04,
  },
  {
    id: 'kie-video-omni',
    label: 'Gemini Omni Flash video',
    task: 'video.generate',
    publicModel: 'gemini-omni-flash-video',
    upstreamModel: 'google/gemini-omni-flash-1-1',
    priceUsd: 0.5,
  },
] as const;

const apiKey = process.env.KIE_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  console.error('KIE_API_KEY is required');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

await sql`
  INSERT INTO sources (id, family, label, description, credit_multiplier, status, min_plan)
  VALUES (${SOURCE_ID}, 'gpt', 'kie.ai Media', 'Image and video models via the kie.ai job API', 1.5, 'active', 'free')
  ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label`;

for (const channel of CHANNELS) {
  await sql`
    INSERT INTO channels (
      id, label, task, provider, base_url, model_id, source_id, public_model_id,
      pricing_type, request_price_usd, input_per_mtok, output_per_mtok, cached_per_mtok,
      status, min_plan, priority
    ) VALUES (
      ${channel.id}, ${channel.label}, ${channel.task}, 'kie_jobs', ${BASE_URL},
      ${channel.upstreamModel}, ${SOURCE_ID}, ${channel.publicModel},
      'request', ${channel.priceUsd}, 0, 0, 0, 'active', 'free', 0
    )
    ON CONFLICT (id) DO UPDATE SET
      task = EXCLUDED.task,
      base_url = EXCLUDED.base_url,
      model_id = EXCLUDED.model_id,
      source_id = EXCLUDED.source_id,
      public_model_id = EXCLUDED.public_model_id,
      request_price_usd = EXCLUDED.request_price_usd`;
  console.log(`channel ${channel.id} -> ${channel.publicModel} (${channel.task})`);
}

const { ciphertext, iv, authTag } = encryptSecret(apiKey);
await sql`DELETE FROM provider_credentials WHERE owner_id IS NULL AND provider = 'kie_jobs' AND base_url = ${BASE_URL}`;
await sql`
  INSERT INTO provider_credentials (owner_id, provider, base_url, ciphertext, iv, auth_tag, last_four, status)
  VALUES (NULL, 'kie_jobs', ${BASE_URL}, ${ciphertext}, ${iv}, ${authTag}, ${apiKey.slice(-4)}, 'active')`;

console.log(`credential: kie_jobs @ ${BASE_URL} (…${apiKey.slice(-4)})`);
await sql.end();

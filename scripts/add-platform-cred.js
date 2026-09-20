import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

/**
 * One-off local seeding helper: inserts the stub provider's platform
 * credential so the openai_compatible channels resolve a key.
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} not set. Source it from .env.local before running this script.`);
    process.exit(1);
  }
  return value;
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321',
  requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
);

const masterKey = Buffer.from(requireEnv('ENCRYPTION_KEY'), 'base64');

const apiKey = 'test-stub-key';

// Encrypt using AES-256-GCM, matching lib/crypto/aes.
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
const authTag = cipher.getAuthTag();

const { data, error } = await supabase
  .from('provider_credentials')
  .insert({
    owner_id: null,
    provider: 'openai_compatible',
    base_url: 'http://localhost:11435/v1',
    ciphertext: encrypted,
    iv,
    auth_tag: authTag,
    last_four: apiKey.slice(-4),
    status: 'active',
  })
  .select();

if (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

console.log('Platform credential added:', data[0].id);
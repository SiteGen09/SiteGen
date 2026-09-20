import { createClient } from '@supabase/supabase-js';
import { encryptSecret } from '../lib/crypto/aes';

/**
 * One-off local seeding helper: inserts the stub provider's platform
 * credential using the app's own encryption path.
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

const apiKey = 'test-stub-key';
const { ciphertext, iv, authTag } = encryptSecret(apiKey);

// Insert as hex strings with the \x prefix (PostgreSQL bytea hex format).
const { data, error } = await supabase
  .from('provider_credentials')
  .insert({
    owner_id: null,
    provider: 'openai_compatible',
    base_url: 'http://localhost:11435/v1',
    ciphertext: '\\x' + ciphertext.toString('hex'),
    iv: '\\x' + iv.toString('hex'),
    auth_tag: '\\x' + authTag.toString('hex'),
    last_four: apiKey.slice(-4),
    status: 'active',
  })
  .select();

if (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

console.log('Platform credential added:', data[0].id);
console.log('Lengths: ciphertext=%d iv=%d authTag=%d', ciphertext.length, iv.length, authTag.length);
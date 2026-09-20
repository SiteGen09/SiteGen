import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

/**
 * One-off local seeding helper: inserts the stub provider's platform
 * credential, encrypting inline so it needs no app imports.
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

function encryptSecret(plaintext) {
  const encoded = process.env.ENCRYPTION_KEY;
  if (!encoded) throw new Error('ENCRYPTION_KEY not set');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return { ciphertext, iv, authTag };
}

const apiKey = 'test-stub-key';
const { ciphertext, iv, authTag } = encryptSecret(apiKey);

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
console.log('Byte lengths: ciphertext=%d iv=%d authTag=%d', ciphertext.length, iv.length, authTag.length);
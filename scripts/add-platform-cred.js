const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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
  requireEnv('SUPABASE_SERVICE_ROLE_KEY')
);

// Read encryption key from env
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY not set');
  process.exit(1);
}

const masterKey = Buffer.from(ENCRYPTION_KEY, 'base64');

async function addPlatformCred() {
  const apiKey = 'test-stub-key';
  
  // Encrypt using AES-256-GCM
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
      iv: iv,
      auth_tag: authTag,
      last_four: apiKey.slice(-4),
      status: 'active'
    })
    .select();
  
  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
  
  console.log('Platform credential added:', data[0].id);
}

addPlatformCred();

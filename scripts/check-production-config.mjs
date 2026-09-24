#!/usr/bin/env node
/**
 * Check the server environment needed by the gensite.tech deployment.
 *
 * This script deliberately reports names and reasons only. It never prints
 * environment values, URLs containing credentials, or secret fragments.
 *
 * Usage:
 *   node scripts/check-production-config.mjs
 *   node scripts/check-production-config.mjs --file .env.production
 */

import { resolve } from 'node:path';
import { config } from 'dotenv';

const args = process.argv.slice(2);
const fileIndex = args.indexOf('--file');
const envFile = fileIndex >= 0 ? args[fileIndex + 1] : '.env.local';
if (fileIndex >= 0 && !envFile) {
  console.error('Usage: node scripts/check-production-config.mjs [--file path]');
  process.exit(2);
}

const resolvedEnvFile = resolve(envFile);
try {
  config({ path: resolvedEnvFile, quiet: true });
} catch {
  // Shell-provided variables can still be checked when the file is absent.
}

const errors = [];
const warnings = [];
const ok = [];

function value(name) {
  return typeof process.env[name] === 'string' ? process.env[name].trim() : '';
}

function required(name, check, message) {
  const current = value(name);
  if (!current) {
    errors.push(`${name}: missing`);
    return '';
  }
  if (!check(current)) {
    errors.push(`${name}: ${message}`);
    return '';
  }
  ok.push(name);
  return current;
}

function secret(name, check = (candidate) => candidate.length >= 16) {
  return required(
    name,
    (candidate) => !/(^your[-_]|^change[-_]|^replace[-_]|^<.*>$|\.{3}|x{4,}|placeholder|example)/i.test(candidate) && check(candidate),
    'placeholder or invalid value',
  );
}

const appUrl = required(
  'NEXT_PUBLIC_APP_URL',
  (candidate) => candidate === 'https://gensite.tech',
  'must be exactly https://gensite.tech',
);
if (appUrl) ok.push('canonical HTTPS app URL');

required(
  'NEXT_PUBLIC_SUPPORT_EMAIL',
  (candidate) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) && candidate === 'admin@gensite.tech',
  'must be admin@gensite.tech',
);
required('NODE_ENV', (candidate) => candidate === 'production', 'must be production');

const supabaseUrl = required(
  'NEXT_PUBLIC_SUPABASE_URL',
  (candidate) => /^https:\/\/[^\s/]+\.supabase\.co(?:\/)?$/.test(candidate),
  'must be the hosted https://<project-ref>.supabase.co URL',
);
if (supabaseUrl) ok.push('hosted Supabase URL');
secret('NEXT_PUBLIC_SUPABASE_ANON_KEY');
secret('SUPABASE_SERVICE_ROLE_KEY');

const databaseUrl = required(
  'DATABASE_URL',
  (candidate) => /^postgres(?:ql)?:\/\//.test(candidate) && !/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(candidate),
  'must be a hosted PostgreSQL URL, not localhost',
);
if (databaseUrl) ok.push('hosted database URL');

const encryptionKey = required(
  'ENCRYPTION_KEY',
  (candidate) => {
    try { return Buffer.from(candidate, 'base64').length === 32; }
    catch { return false; }
  },
  'must decode from base64 to exactly 32 bytes',
);
if (encryptionKey) ok.push('32-byte encryption key');

for (const name of [
  'WHOP_ACCOUNT_ID',
  'WHOP_API_KEY',
  'WHOP_WEBHOOK_SECRET',
  'WHOP_PLAN_STARTER',
  'WHOP_PLAN_PRO',
  'WHOP_PLAN_MAX',
  'WHOP_PRODUCT_CREDITS',
  'CRON_SECRET',
  'REDEMPTION_CODE_PEPPER',
]) {
  secret(name);
}

if (!value('ANTHROPIC_API_KEY') && !value('RELAY_API_KEY')) {
  warnings.push('No ANTHROPIC_API_KEY or RELAY_API_KEY is set; add a provider credential in the admin portal before testing generation.');
} else {
  ok.push('AI provider credential present');
}

if (value('WHOP_PLAN_TOPUP')) {
  warnings.push('WHOP_PLAN_TOPUP is retired; use WHOP_PRODUCT_CREDITS and remove the old variable.');
}

if (value('MEDIA_GENERATION_ENABLED') === 'true') {
  if (value('MODERATION_MODE') !== 'remote' || value('MEDIA_OUTPUT_MODERATION') !== 'remote' || value('MEDIA_OUTPUT_MODERATION_READY') !== 'true' || !value('MODERATION_API_KEY')) {
    errors.push('MEDIA_GENERATION_ENABLED: requires tested remote prompt/output moderation, MEDIA_OUTPUT_MODERATION_READY=true, and MODERATION_API_KEY');
  } else {
    ok.push('moderated image generation enabled');
  }
} else {
  warnings.push('Media generation is disabled; video remains unavailable until a supported output-screening workflow is deployed.');
}

console.log(`Production configuration check: ${resolvedEnvFile}`);
for (const name of ok.filter((item, index, items) => items.indexOf(item) === index)) console.log(`OK   ${name}`);
for (const warning of warnings) console.log(`WARN ${warning}`);
for (const error of errors) console.log(`ERROR ${error}`);

if (errors.length) {
  console.log(`\n${errors.length} required setting(s) need attention. No secret values were printed.`);
  process.exit(1);
}
console.log('\nProduction environment values passed the required checks.');

#!/usr/bin/env node
/**
 * Sign and POST a Whop webhook to a local server — no tunnel required.
 *
 * Whop signs `{webhook-id}.{webhook-timestamp}.{raw body}` with HMAC-SHA256
 * over the `ws_...` secret, base64, sent as `v1,<sig>`. Deliveries more than
 * five minutes old are rejected, so the timestamp is generated fresh here.
 *
 *   node scripts/send-whop-webhook.mjs membership.activated
 *   node scripts/send-whop-webhook.mjs payment.succeeded ./my-payload.json
 *
 * Reads WHOP_WEBHOOK_SECRET and NEXT_PUBLIC_APP_URL from .env.local.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function loadEnv() {
  const env = {};
  try {
    const raw = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match !== null) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // Fall through to process.env.
  }
  return { ...env, ...process.env };
}

/** Minimal payloads that satisfy whopMembershipSchema / whopPaymentSchema. */
function samplePayload(type) {
  const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
  if (type.startsWith('payment')) {
    return {
      id: `pay_${randomUUID().slice(0, 8)}`,
      status: 'succeeded',
      plan_id: 'plan_REPLACE_ME',
      membership_id: `mem_${randomUUID().slice(0, 8)}`,
      user: { id: 'user_REPLACE_ME', email: 'dev@example.com' },
      billing_reason: 'subscription_cycle',
    };
  }
  return {
    id: `mem_${randomUUID().slice(0, 8)}`,
    status: type.includes('invalid') || type.includes('deactivated') ? 'expired' : 'active',
    plan_id: 'plan_REPLACE_ME',
    user: { id: 'user_REPLACE_ME', email: 'dev@example.com' },
    current_period_end: periodEnd,
    renewal_period_end: periodEnd,
  };
}

const [type = 'membership.activated', payloadPath] = process.argv.slice(2);
const env = await loadEnv();

const secret = env.WHOP_WEBHOOK_SECRET;
if (secret === undefined || secret === '') {
  console.error('WHOP_WEBHOOK_SECRET is not set (checked .env.local and the environment).');
  process.exit(1);
}

const data =
  payloadPath === undefined
    ? samplePayload(type)
    : JSON.parse(await readFile(payloadPath, 'utf8'));

const body = JSON.stringify({ id: `evt_${randomUUID()}`, type, data });
const webhookId = `msg_${randomUUID()}`;
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', secret)
  .update(`${webhookId}.${timestamp}.${body}`, 'utf8')
  .digest('base64');

const base = env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const response = await fetch(`${base}/api/webhooks/whop`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'webhook-id': webhookId,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  },
  body,
});

console.log(`${response.status} ${response.statusText}`);
console.log(await response.text());

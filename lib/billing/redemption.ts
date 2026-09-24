import { createHmac, randomBytes } from 'node:crypto';
import { sql } from '@/lib/db';
import { writeAudit } from '@/lib/api/admin';

export const REDEMPTION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_REDEMPTION_CREDITS = 100_000_000;
export const MAX_CODE_REDEMPTIONS = 100_000;

export type RedemptionResult =
  | { status: 'redeemed'; credits: number; codePrefix: string }
  | { status: 'duplicate'; credits: number; codePrefix: string };

function pepper(): string {
  const value =
    process.env.REDEMPTION_CODE_PEPPER ||
    process.env.WHOP_WEBHOOK_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (value === undefined || value === '') {
    throw new Error('Redemption codes are not configured');
  }
  return value;
}

export function normalizeRedemptionCode(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a redemption code.');
  const normalized = value.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{8,64}$/.test(normalized)) {
    throw new Error('Enter a valid redemption code.');
  }
  return normalized;
}

export function hashRedemptionCode(value: unknown): string {
  return createHmac('sha256', pepper()).update(normalizeRedemptionCode(value), 'utf8').digest('hex');
}

export function formatRedemptionCode(raw: string): string {
  const normalized = normalizeRedemptionCode(raw);
  return normalized.match(/.{1,4}/g)?.join('-') ?? normalized;
}

export function generateRedemptionCode(): string {
  const bytes = randomBytes(16);
  let raw = '';
  for (const byte of bytes) raw += REDEMPTION_CODE_ALPHABET[byte % REDEMPTION_CODE_ALPHABET.length];
  return formatRedemptionCode(raw);
}

function parseCredits(value: unknown): number {
  const credits = Number(value);
  if (!Number.isSafeInteger(credits) || credits <= 0 || credits > MAX_REDEMPTION_CREDITS) {
    throw new Error(`Credits must be a whole number from 1 to ${MAX_REDEMPTION_CREDITS.toLocaleString()}.`);
  }
  return credits;
}

export async function redeemCreditCode(userId: string, inputCode: unknown): Promise<RedemptionResult> {
  const attempts = await sql`INSERT INTO guard_counters AS c (bucket,window_start,hits)
    VALUES (${'redeem:' + userId},date_trunc('minute',now()),1)
    ON CONFLICT(bucket) DO UPDATE SET window_start=date_trunc('minute',now()),
      hits=CASE WHEN c.window_start=date_trunc('minute',now()) THEN c.hits+1 ELSE 1 END RETURNING hits`;
  if (attempts[0]!.hits > 10) throw new Error('Too many attempts. Try again in a minute.');
  const codeHash = hashRedemptionCode(inputCode);
  return sql.begin(async (tx) => {
    const profiles = await tx`SELECT status,billing_hold FROM profiles WHERE id=${userId} FOR UPDATE`;
    if (profiles[0]?.status !== 'active' || profiles[0]?.billing_hold) throw new Error('Account access is frozen. Contact support for review.');
    const rows = await tx<{ id: string; code_prefix: string; credits: number; max_redemptions: number; redemption_count: number; expires_at: Date | string | null; active: boolean }[]>`
      SELECT id, code_prefix, credits, max_redemptions, redemption_count, expires_at, active
      FROM credit_redemption_codes
      WHERE code_hash = ${codeHash}
      FOR UPDATE
    `;
    const code = rows[0];
    if (code === undefined || !code.active || (code.expires_at !== null && new Date(code.expires_at).getTime() <= Date.now())) {
      throw new Error('Invalid or unavailable redemption code.');
    }

    const existing = await tx<{ credits: number }[]>`
      SELECT credits FROM credit_code_redemptions WHERE code_id = ${code.id} AND user_id = ${userId}
    `;
    if (existing[0] !== undefined) {
      return { status: 'duplicate', credits: Number(existing[0].credits), codePrefix: code.code_prefix };
    }
    if (code.redemption_count >= code.max_redemptions) {
      throw new Error('Invalid or unavailable redemption code.');
    }

    const requestId = `redemption-code-${code.id}-${userId}`;
    await tx`
      INSERT INTO ledger (user_id, request_id, kind, credits, meta)
      VALUES (${userId}, ${requestId}, 'topup', ${code.credits}, ${JSON.stringify({ source: 'redemption_code', code_id: code.id, code_prefix: code.code_prefix })}::jsonb)
    `;
    await tx`
      INSERT INTO credit_code_redemptions (code_id, user_id, request_id, credits, meta)
      VALUES (${code.id}, ${userId}, ${requestId}, ${code.credits}, ${JSON.stringify({ source: 'redemption_code', code_prefix: code.code_prefix })}::jsonb)
    `;
    await tx`
      UPDATE credit_redemption_codes
      SET redemption_count = redemption_count + 1, updated_at = now()
      WHERE id = ${code.id}
    `;
    return { status: 'redeemed', credits: Number(code.credits), codePrefix: code.code_prefix };
  });
}

export async function createRedemptionCode(input: {
  createdBy: string;
  credits: number;
  maxRedemptions: number;
  expiresAt: string | null;
  label: string | null;
}): Promise<{ code: string; id: string }> {
  const credits = parseCredits(input.credits);
  if (!Number.isSafeInteger(input.maxRedemptions) || input.maxRedemptions < 1 || input.maxRedemptions > MAX_CODE_REDEMPTIONS) {
    throw new Error(`Redemptions must be from 1 to ${MAX_CODE_REDEMPTIONS.toLocaleString()}.`);
  }
  const expiresAt = input.expiresAt === null || input.expiresAt === '' ? null : new Date(input.expiresAt);
  if (expiresAt !== null && !Number.isFinite(expiresAt.getTime())) throw new Error('Enter a valid expiration date.');
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) throw new Error('Expiration must be in the future.');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateRedemptionCode();
    const codeHash = hashRedemptionCode(code);
    try {
      return await sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO credit_redemption_codes (code_hash, code_prefix, credits, max_redemptions, expires_at, created_by, label)
        VALUES (${codeHash}, ${code.slice(0, 11)}, ${credits}, ${input.maxRedemptions}, ${expiresAt?.toISOString() ?? null}, ${input.createdBy}, ${input.label})
        RETURNING id
      `;
      const id = rows[0]?.id;
      if (!id) throw new Error('Code creation failed.');
      await writeAudit(input.createdBy, 'credits.redemption_code.create', 'redemption_code:' + id, null, { credits, max_redemptions: input.maxRedemptions, expires_at: input.expiresAt, label: input.label, code_prefix: code.slice(0, 11) }, tx);
      return { code, id };
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') continue;
      throw error;
    }
  }
  throw new Error('Could not generate a unique redemption code.');
}

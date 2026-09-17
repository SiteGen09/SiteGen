/**
 * Credit ledger concurrency test (named deliverable).
 *
 * Two simultaneous holds from a user with enough credits for exactly one
 * must produce exactly one success and one rejection — never an overdraw.
 *
 * Requires a running local Supabase stack with migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let userId: string;

const holdResultSchema = z.object({
  success: z.boolean(),
  duplicate: z.boolean().optional(),
  error: z.string().optional(),
  balance: z.number().optional(),
});
type HoldResult = z.infer<typeof holdResultSchema>;

const settleResultSchema = z.object({
  success: z.boolean(),
  duplicate: z.boolean().optional(),
});

async function hold(requestId: string, credits: number): Promise<HoldResult> {
  const { data, error } = await admin.rpc('hold_credits', {
    p_user_id: userId,
    p_request_id: requestId,
    p_estimated_credits: credits,
    p_channel_id: null,
  });
  if (error) throw new Error(`hold_credits rpc failed: ${error.message}`);
  return holdResultSchema.parse(data);
}

async function balance(): Promise<number> {
  const { data, error } = await admin.rpc('get_balance', { p_user_id: userId });
  if (error) throw new Error(`get_balance rpc failed: ${error.message}`);
  return Number(data);
}

beforeAll(async () => {
  const email = `credit-test-${Date.now()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'test-password-12345',
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  userId = data.user.id;
}, 30_000);

afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId);
});

describe('credit ledger concurrency', () => {
  it('parallel holds: enough for exactly one → one success, one rejection', async () => {
    // Grant exactly 100 credits.
    await admin.from('ledger').insert({
      user_id: userId,
      request_id: `cc-grant-${Date.now()}`,
      kind: 'grant',
      credits: 100,
    });

    const [r1, r2] = await Promise.all([
      hold(`cc-hold-1-${Date.now()}`, 100),
      hold(`cc-hold-2-${Date.now()}`, 100),
    ]);

    const successes = [r1, r2].filter((r) => r.success).length;
    const rejections = [r1, r2].filter((r) => !r.success && r.error === 'insufficient_credits').length;
    expect(successes).toBe(1);
    expect(rejections).toBe(1);
    expect(await balance()).toBe(0);
  });

  it('many parallel holds never overdraw', async () => {
    // Fresh user state: current balance is 0; grant 300 (enough for 3 holds of 100).
    await admin.from('ledger').insert({
      user_id: userId,
      request_id: `cc-grant2-${Date.now()}`,
      kind: 'grant',
      credits: 300,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => hold(`cc-many-${i}-${Date.now()}`, 100))
    );
    const successes = results.filter((r) => r.success).length;
    expect(successes).toBe(3);
    expect(await balance()).toBe(0);
  });

  it('settle reverses hold and charges actuals', async () => {
    await admin.from('ledger').insert({
      user_id: userId,
      request_id: `cc-grant3-${Date.now()}`,
      kind: 'grant',
      credits: 100,
    });
    const rid = `cc-settle-${Date.now()}`;
    const h = await hold(rid, 50);
    expect(h.success).toBe(true);
    expect(await balance()).toBe(50);

    const { error } = await admin.rpc('settle_credits', {
      p_request_id: rid,
      p_actual_credits: 30,
      p_meta: { input_tokens: 100, output_tokens: 200 },
    });
    expect(error).toBeNull();
    // 100 - 50 (hold) + 50 (release) - 30 (settle) = 70
    expect(await balance()).toBe(70);
  });

  it('settle is idempotent', async () => {
    const before = await balance();
    const rid = `cc-settle2-${Date.now()}`;
    await hold(rid, 10);
    await admin.rpc('settle_credits', { p_request_id: rid, p_actual_credits: 5 });
    const { data } = await admin.rpc('settle_credits', { p_request_id: rid, p_actual_credits: 5 });
    expect(settleResultSchema.parse(data).duplicate).toBe(true);
    expect(await balance()).toBe(before - 5);
  });

  it('release reverses hold with no charge', async () => {
    const before = await balance();
    const rid = `cc-release-${Date.now()}`;
    await hold(rid, 10);
    expect(await balance()).toBe(before - 10);
    const { error } = await admin.rpc('release_credits', { p_request_id: rid });
    expect(error).toBeNull();
    expect(await balance()).toBe(before);
  });

  it('duplicate hold request_id is idempotent, not double-held', async () => {
    const before = await balance();
    const rid = `cc-dup-${Date.now()}`;
    await hold(rid, 10);
    const dup = await hold(rid, 10);
    expect(dup.success).toBe(true);
    expect(dup.duplicate).toBe(true);
    expect(await balance()).toBe(before - 10);
  });
});

import { sql } from '@/lib/db';

export async function billingAccess(userId: string) {
  const rows = await sql`SELECT status, billing_hold FROM profiles WHERE id=${userId}`;
  return rows[0]?.status === 'active' && rows[0]?.billing_hold === false;
}

export async function assertBillingAccess(userId: string) {
  if (!await billingAccess(userId)) throw new Error('Account access is frozen. Contact support for review.');
}

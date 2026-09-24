import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { whopFetch } from './whop';
import { parseUsdCents } from './catalog';
import { retrieveReceipt, syncPurchase } from './purchases';

export const disputeSchema = z.object({
  id: z.string().min(1), account_id: z.string(),
  payment: z.object({ id: z.string().min(1) }),
  status: z.string().min(1), amount: z.union([z.number(), z.string()]),
  currency: z.literal('usd'), reason: z.string().nullish(),
  updated_at: z.iso.datetime({ offset: true }), evidence_due_at: z.iso.datetime({ offset: true }).nullish(),
});

export async function syncDispute(service: SupabaseClient, id: string): Promise<boolean> {
  const dispute = disputeSchema.parse(await whopFetch(`/disputes/${encodeURIComponent(id)}`));
  if (dispute.id !== id || dispute.account_id !== process.env.WHOP_ACCOUNT_ID) throw new Error('Dispute account mismatch');
  // Refresh accounting only for a previously confirmed payment.
  const receipt = await retrieveReceipt(dispute.payment.id);
  const purchase = await syncPurchase(service, receipt);
  // A paid receipt by itself must never create credits. The repair helper only
  // proceeds when a handled payment.succeeded row already established the
  // payment-to-user attribution.
  if (!purchase.handled) return false;
  const { error } = await service.rpc('sync_whop_dispute', {
    p_id: id, p_payment: receipt.id, p_status: dispute.status,
    p_amount: parseUsdCents(String(dispute.amount)), p_currency: dispute.currency,
    p_reason: dispute.reason ?? null, p_updated: dispute.updated_at, p_due: dispute.evidence_due_at ?? null,
  });
  if (error) throw new Error(`Dispute accounting failed: ${error.message}`);
  return true;
}

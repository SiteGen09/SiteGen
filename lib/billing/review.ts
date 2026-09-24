import { sql } from '@/lib/db';
import { writeAudit } from '@/lib/api/admin';

// Caller must independently authorize the administrator. Lock the owner before
// dispute rows, matching the webhook's lock order. Never alter manual status.
export async function releaseDisputeHold(actor: string, disputeId: string, note: string) {
  await sql.begin(async tx => {
    const match = await tx`SELECT user_id FROM billing_disputes WHERE id=${disputeId}`;
    const userId = match[0]?.user_id;
    if (!userId) throw new Error('Customer is unavailable.');
    await tx`SELECT id FROM profiles WHERE id=${userId} FOR UPDATE`;
    const rows = await tx`SELECT * FROM billing_disputes WHERE id=${disputeId} FOR UPDATE`;
    const dispute = rows[0];
    if (!dispute) throw new Error('Dispute is unavailable.');
    if (!['won','closed','warning_closed'].includes(dispute.status)) throw new Error('Only a won or closed dispute can be released. Review the case in Whop first.');
    if (dispute.reviewed_at) return;
    await tx`UPDATE billing_disputes SET reviewed_at=now(),reviewed_by=${actor},review_note=${note} WHERE id=${disputeId}`;
    const pending = await tx`SELECT 1 FROM billing_disputes WHERE user_id=${userId} AND reviewed_at IS NULL LIMIT 1`;
    if (!pending.length) await tx`UPDATE profiles SET billing_hold=false,billing_hold_reason=null,billing_hold_at=null WHERE id=${userId}`;
    await writeAudit(actor,'billing.dispute.review','dispute:'+disputeId, {status:dispute.status,reviewed:false}, {reviewed:true,note,hold_remaining:pending.length>0}, tx);
  });
}

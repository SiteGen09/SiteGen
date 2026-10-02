import Link from 'next/link';

import { formatUsd } from '@/lib/billing/catalog';
import type { UserReferralPanel } from '@/lib/referrals/admin';

import { Card, EmptyRow, Stat, Td, Th } from '../../_components/ui';
import { PayoutForm, ReferrerForm } from '../../referrals/_components/forms';

const number = (value: number) => value.toLocaleString('en-US');
const date = (value: Date) => value.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Admin-only view of one user's referral rewards, with the cash payout tool. */
export function ReferralPanel({ userId, panel, defaultBps, now }: {
  userId: string; panel: UserReferralPanel; defaultBps: number; now: Date;
}) {
  const { wallet } = panel;
  return (
    <Card title="Referral rewards">
      <div className="space-y-5 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-zinc-300">
          <span>Code: <span className="font-mono text-zinc-100">{panel.account?.code ?? 'not created yet'}</span></span>
          <span>Referred by: {panel.referredBy === null ? '—' : <>
            <Link href={'/admin/users/' + panel.referredBy.user_id} className="underline">{panel.referredBy.email ?? panel.referredBy.user_id}</Link>
            {' '}on {date(panel.referredBy.created_at)}{panel.referredBy.bonus_credits > 0 && <> · welcome bonus {number(panel.referredBy.bonus_credits)} credits</>}
          </>}</span>
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Pending" value={number(wallet.pending)} detail="still in the hold period" />
          <Stat label="Available" value={number(wallet.available)} tone={wallet.available < 0 ? 'alert' : undefined} detail="in the rewards wallet" />
          <Stat label="Transferred" value={number(wallet.transferred)} detail={number(wallet.reclaimable) + ' reclaimable for cash'} />
          <Stat label="Paid out as cash" value={number(wallet.paid_out)} detail={number(wallet.invites) + (wallet.invites === 1 ? ' invite' : ' invites')} />
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Referrer settings</div>
          <ReferrerForm userId={userId} commissionBps={panel.account?.commission_bps ?? null} frozen={panel.account?.frozen ?? false} defaultBps={defaultBps} />
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Cash payout</div>
          <PayoutForm userId={userId} available={Math.max(wallet.available, 0)} reclaimable={wallet.reclaimable} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem]">
            <thead><tr><Th>When</Th><Th>From</Th><Th>Payment</Th><Th>Rate</Th><Th>Reward</Th><Th>Unlocks</Th></tr></thead>
            <tbody className="divide-y divide-zinc-800">
              {panel.commissions.length === 0 ? <EmptyRow colSpan={6} label="No rewards earned." /> : panel.commissions.map((row) => (
                <tr key={row.payment_id}>
                  <Td><span className="whitespace-nowrap">{date(row.created_at)}</span></Td>
                  <Td>{row.email ?? '—'}</Td>
                  <Td>{formatUsd(row.base_cents)} {row.order_kind}<div className="font-mono text-xs text-zinc-500">{row.payment_id}</div></Td>
                  <Td>{row.rate_bps / 100}%</Td>
                  <Td>{number(row.credits)}{row.credits < row.full_credits && <span className="text-xs text-zinc-500"> of {number(row.full_credits)}</span>}</Td>
                  <Td>{row.available_at > now ? date(row.available_at) : 'unlocked'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {panel.invited.length > 0 && (
          <div>
            <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Invited users ({panel.invited.length})</div>
            <ul className="space-y-1">
              {panel.invited.map((row) => (
                <li key={row.referred_id} className="flex flex-wrap gap-x-3 text-zinc-300">
                  <Link href={'/admin/users/' + row.referred_id} className="underline">{row.email ?? row.referred_id}</Link>
                  <span className="text-zinc-500">joined {date(row.created_at)} · earned {number(row.earned)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {panel.payouts.length > 0 && (
          <div>
            <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Cash payouts</div>
            <ul className="space-y-1 text-zinc-300">
              {panel.payouts.map((row) => (
                <li key={row.id}>
                  {date(row.created_at)} · {number(row.credits)} credits from {row.source} · {(row.cash_cents / 100).toFixed(2)} {(row.cash_currency ?? '').toUpperCase()} via {row.method}
                  {row.reference && <span className="font-mono text-xs text-zinc-500"> · {row.reference}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

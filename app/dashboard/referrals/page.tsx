import { requireUser } from '@/lib/dashboard/session';
import { referralLink } from '@/lib/referrals/code';
import { formatRate, referralOverview, type ReferralActivity } from '@/lib/referrals/referrals';
import { SITE_URL } from '@/lib/site-config';
import { CopyButton } from '../../setup/copy-button';
import { Card, EmptyRow, PageHeader, Table, formatCredits, formatCreditsUsd, formatTimestamp } from '../ui';
import { TransferButton } from './transfer-button';

export const metadata = { title: 'Referrals - sitegen' };
export const dynamic = 'force-dynamic';

const STATUS: Record<ReferralActivity['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700' },
  available: { label: 'Unlocked', className: 'bg-emerald-50 text-emerald-700' },
  partially_reversed: { label: 'Partly refunded', className: 'bg-zinc-100 text-zinc-600' },
  reversed: { label: 'Refunded', className: 'bg-zinc-100 text-zinc-600' },
  done: { label: 'Done', className: 'bg-zinc-100 text-zinc-600' },
};

export default async function ReferralsPage() {
  const user = await requireUser();
  const overview = await referralOverview(user.id);
  const { wallet } = overview;
  const link = referralLink(SITE_URL, overview.code);
  const available = Math.max(wallet.available, 0);
  const canTransfer = overview.enabled && !overview.frozen && available > 0;

  return <>
    <PageHeader title="Referrals" description="Share your link. When people you refer add funds, you earn credits." />

    <Card>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-md">
          <h2 className="font-semibold text-zinc-900">Referral program</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Earn {formatRate(overview.rateBps)} in credits when your referrals add funds. New users who sign up with your link
            get {formatRate(overview.bonusBps)} extra credits on their first top-up.
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-6 text-center">
          <div><dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Pending</dt><dd className="mt-1 font-semibold tabular-nums">{formatCreditsUsd(wallet.pending)}</dd></div>
          <div><dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Total earned</dt><dd className="mt-1 font-semibold tabular-nums">{formatCreditsUsd(wallet.total_earned)}</dd></div>
          <div><dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Invites</dt><dd className="mt-1 font-semibold tabular-nums">{wallet.invites.toLocaleString('en-US')}</dd></div>
        </dl>
      </div>
      <div className="mt-5 flex min-w-0 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2">
        <code className="min-w-0 flex-1 truncate px-1 text-sm text-zinc-800" title={link}>{link}</code>
        <CopyButton value={link} label="Copy link" />
      </div>
      <p className="mt-2 text-xs text-zinc-500">Your code: <span className="font-mono font-medium text-zinc-700">{overview.code}</span></p>
    </Card>

    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <Card>
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Ready to transfer</p>
        <p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900">{formatCredits(available)} <span className="text-sm font-normal text-zinc-500">credits</span></p>
        <p className="mt-1 text-xs text-zinc-500">≈ {formatCreditsUsd(available)}</p>
        <div className="mt-4"><TransferButton disabled={!canTransfer} /></div>
        {overview.frozen && <p className="mt-3 text-sm text-amber-700">Referral rewards are paused on this account. Contact support for details.</p>}
      </Card>
      <Card>
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">How it works</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-600">
          <li>Rewards unlock {overview.holdDays === 0 ? 'right away' : `${overview.holdDays} days after the payment`}, then you can transfer them to your balance.</li>
          <li>If a payment is refunded or disputed, its reward is reduced or removed.</li>
          <li>Referral rewards are promotional credits for sitegen usage. They have no cash value and cannot be exchanged for cash on request.</li>
        </ul>
      </Card>
    </div>

    <h2 className="mb-3 mt-8 text-base font-semibold">Activity</h2>
    <Table head={['When', 'Activity', 'Credits', 'Status']}>
      {overview.activity.length === 0
        ? <EmptyRow colSpan={4}>No referral activity yet. Share your link to get started.</EmptyRow>
        : overview.activity.map((row) => (
          <tr key={row.id}>
            <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600">{formatTimestamp(row.at)}</td>
            <td className="px-4 py-2.5">{row.label}</td>
            <td className={`whitespace-nowrap px-4 py-2.5 tabular-nums ${row.credits < 0 ? 'text-zinc-600' : 'text-emerald-700'}`}>
              {row.credits > 0 ? '+' : ''}{formatCredits(row.credits)}
            </td>
            <td className="px-4 py-2.5"><span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS[row.status].className}`}>{STATUS[row.status].label}</span></td>
          </tr>
        ))}
    </Table>
  </>;
}

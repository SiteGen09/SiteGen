import Link from 'next/link';

import { requireAdmin } from '@/lib/api/admin';
import { formatUsd } from '@/lib/billing/catalog';
import { referralPayouts, referralSettings, topReferrers } from '@/lib/referrals/admin';

import { Badge, Card, EmptyRow, PageTitle, Td, Th } from '../_components/ui';
import { SettingsForm } from './_components/forms';

export const dynamic = 'force-dynamic';

const number = (value: number) => value.toLocaleString('en-US');
const date = (value: Date) => value.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const rate = (bps: number) => (bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';

export default async function AdminReferralsPage() {
  await requireAdmin();
  const [settings, referrers, payouts] = await Promise.all([referralSettings(), topReferrers(), referralPayouts()]);
  return (
    <>
      <PageTitle title="Referrals" subtitle="Every user has a referral code. Rewards are promotional credits; cash payouts are recorded here only." />
      <div className="space-y-5">
        <Card title="Program settings">
          <SettingsForm settings={settings} />
          <p className="mt-3 text-xs text-zinc-500">
            Changes apply to payments made after saving. Rewards already earned keep their rate and unlock date. Last changed {date(settings.updated_at)}.
          </p>
        </Card>

        <Card title="Referrers">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead><tr><Th>User</Th><Th>Code</Th><Th>Rate</Th><Th>Invites</Th><Th>Paying</Th><Th>Earned</Th><Th>Paid out as cash</Th></tr></thead>
              <tbody className="divide-y divide-zinc-800">
                {referrers.length === 0 ? <EmptyRow colSpan={7} label="Nobody has signed up with a referral code yet." /> : referrers.map((row) => (
                  <tr key={row.user_id}>
                    <Td><Link href={'/admin/users/' + row.user_id} className="underline">{row.email}</Link>{row.frozen && <span className="ml-2"><Badge value="frozen" /></span>}</Td>
                    <Td><span className="font-mono">{row.code}</span></Td>
                    <Td>{row.commission_bps === null ? rate(settings.commission_bps) : <span className="text-amber-300">{rate(row.commission_bps)}</span>}</Td>
                    <Td>{number(row.invites)}</Td>
                    <Td>{number(row.paying)}</Td>
                    <Td>{number(row.total_earned)}</Td>
                    <Td>{number(row.paid_out)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-zinc-500">Credits. Set a per-user rate, freeze rewards or record a cash payout from the user&apos;s admin page.</p>
        </Card>

        <Card title="Cash payouts">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead><tr><Th>When</Th><Th>User</Th><Th>Credits</Th><Th>From</Th><Th>Cash</Th><Th>Method</Th><Th>Reference / note</Th><Th>By</Th></tr></thead>
              <tbody className="divide-y divide-zinc-800">
                {payouts.length === 0 ? <EmptyRow colSpan={8} label="No cash payouts recorded." /> : payouts.map((row) => (
                  <tr key={row.id}>
                    <Td><span className="whitespace-nowrap">{date(row.created_at)}</span></Td>
                    <Td><Link href={'/admin/users/' + row.user_id} className="underline">{row.email ?? row.user_id}</Link></Td>
                    <Td>{number(row.credits)}</Td>
                    <Td>{row.source === 'wallet' ? 'Rewards wallet' : 'Balance'}</Td>
                    <Td>{row.cash_currency === 'usd' ? formatUsd(row.cash_cents) : (row.cash_cents / 100).toFixed(2) + ' ' + (row.cash_currency ?? '').toUpperCase()}</Td>
                    <Td>{row.method}</Td>
                    <Td>{row.reference && <div className="break-all font-mono text-xs">{row.reference}</div>}{row.note && <div className="max-w-xs break-words text-xs text-zinc-400">{row.note}</div>}</Td>
                    <Td>{row.actor_email ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}

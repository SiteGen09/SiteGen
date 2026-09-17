import Link from 'next/link';
import { getPlans } from '@/lib/billing/plans';
import { getBalance, getEntitlement, listLedger } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import {
  EmptyRow,
  PageHeader,
  Stat,
  StatusBadge,
  Table,
  formatCredits,
  formatTimestamp,
} from './ui';

export const metadata = { title: 'Overview — sitegen' };

const LEDGER_HEAD = ['Kind', 'Credits', 'Request ID', 'When'] as const;

export default async function OverviewPage() {
  const user = await requireUser();
  const [balance, entitlement, ledger] = await Promise.all([
    getBalance(),
    getEntitlement(user.id),
    listLedger({ limit: 10 }),
  ]);

  const plan = getPlans()[entitlement.planKey];
  const usdValue = (balance * 0.0001).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });

  return (
    <>
      <PageHeader title="Overview" description="Credits, plan and recent ledger activity." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Credit balance" value={formatCredits(balance)} hint={`≈ ${usdValue}`} />
        <Stat
          label="Plan"
          value={plan.label}
          hint={`${entitlement.status} · ${formatCredits(plan.rateLimitRpm)} rpm per key`}
        />
        <Stat
          label="Monthly credits"
          value={formatCredits(entitlement.monthlyCredits)}
          hint={
            entitlement.currentPeriodEnd === null
              ? 'no active period'
              : `renews ${formatTimestamp(entitlement.currentPeriodEnd)}`
          }
        />
      </div>

      <div className="mt-8 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-zinc-900">Recent ledger</h2>
        <Link href="/dashboard/usage" className="text-sm text-zinc-600 underline">
          Full history
        </Link>
      </div>

      <div className="mt-3">
        <Table head={LEDGER_HEAD}>
          {ledger.length === 0 ? (
            <EmptyRow colSpan={LEDGER_HEAD.length}>
              No activity yet. Create an API key to get started.
            </EmptyRow>
          ) : (
            ledger.map((entry) => (
              <tr key={entry.id}>
                <td className="px-4 py-2.5">
                  <StatusBadge status={entry.kind} />
                </td>
                <td
                  className={`px-4 py-2.5 tabular-nums ${
                    entry.credits < 0 ? 'text-red-700' : 'text-emerald-700'
                  }`}
                >
                  {entry.credits > 0 ? '+' : ''}
                  {formatCredits(entry.credits)}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-600">{entry.request_id}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600">
                  {formatTimestamp(entry.created_at)}
                </td>
              </tr>
            ))
          )}
        </Table>
      </div>
    </>
  );
}

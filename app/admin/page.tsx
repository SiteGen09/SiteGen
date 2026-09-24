import Link from 'next/link';

import { requireAdmin } from '@/lib/api/admin';
import { negativeBalances } from '@/lib/admin/metrics';
import {
  parseUsageRange, parseUsageSort, recentRequests, topConsumers, usageMonitoring,
} from '@/lib/admin/usage-monitoring';

import { LiveRefresh } from './_components/live-refresh';
import { PageTitle, Stat, Td, Th } from './_components/ui';
import { ProfitSummary, RecentRequests, TopConsumers, UsageFilters, UsageMonitor } from './_components/usage-monitor';

export const dynamic = 'force-dynamic';

function renderTime(): Date {
  return new Date();
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0%' : ((part / whole) * 100).toFixed(1) + '%';
}

export default async function AdminOverviewPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const rawParams = await searchParams;
  const params = Object.fromEntries(Object.entries(rawParams).map(([key, value]) => [key, typeof value === 'string' ? value : undefined]));
  const range = parseUsageRange(params.range);
  const sort = parseUsageSort(params.sort);
  const now = renderTime();
  const [monitoring, overdrawn, consumers, recent] = await Promise.all([
    usageMonitoring(range, sort),
    negativeBalances(),
    topConsumers(range, 10),
    recentRequests({ limit: 20 }),
  ]);
  const { summary } = monitoring;

  return (
    <>
      <PageTitle title="Overview" subtitle="Revenue, provider cost and profit, and the models, routes and users behind them." />
      <LiveRefresh renderedAt={now.toISOString()} />
      <UsageFilters range={range} sort={sort} />

      {overdrawn.length > 0 && (
        <div className="mb-6 rounded-lg border border-rose-500/40 bg-rose-500/10 p-4">
          <h2 className="text-sm font-semibold text-rose-300">Negative balance alert — {overdrawn.length} user(s) overdrawn</h2>
          <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[34rem] text-sm">
            <thead><tr><Th>User</Th><Th>Email</Th><Th>Balance (credits)</Th></tr></thead>
            <tbody className="divide-y divide-rose-500/20">{overdrawn.map((row) => (
              <tr key={row.user_id}><Td><span className="font-mono text-xs text-zinc-400">{row.user_id}</span></Td><Td><Link href={'/admin/users/' + row.user_id} className="underline underline-offset-4">{row.email}</Link></Td><Td><span className="font-semibold text-rose-300">{row.balance.toLocaleString()}</span></Td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      <ProfitSummary totals={summary} />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Requests" value={summary.requests.toLocaleString()} detail={summary.successful_requests.toLocaleString() + ' successful'} />
        <Stat label="Consumers" value={summary.consumers.toLocaleString()} />
        <Stat label="Error rate" value={pct(summary.errors, summary.requests)} tone={summary.errors > 0 ? 'alert' : undefined} />
        <Stat label="p95 latency" value={summary.p95_latency_ms === null ? '—' : Math.round(summary.p95_latency_ms) + ' ms'} />
      </div>

      <div className="mb-5 space-y-5">
        <RecentRequests rows={recent} now={now} />
        <TopConsumers rows={consumers} range={range} />
      </div>

      <UsageMonitor data={monitoring} params={{ ...params, range, sort }} />

    </>
  );
}

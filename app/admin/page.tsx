import { requireAdmin } from '@/lib/api/admin';
import {
  negativeBalances,
  usageByChannel24h,
  usageSummary24h,
} from '@/lib/admin/metrics';

import { Card, PageTitle, Stat, Td, Th, EmptyRow } from './_components/ui';

export const dynamic = 'force-dynamic';

function pct(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

export default async function AdminOverviewPage() {
  await requireAdmin();

  const [summary, byChannel, overdrawn] = await Promise.all([
    usageSummary24h(),
    usageByChannel24h(),
    negativeBalances(),
  ]);

  return (
    <>
      <PageTitle title="Overview" subtitle="Rolling 24-hour serving metrics." />

      {overdrawn.length > 0 && (
        <div className="mb-6 rounded-lg border border-rose-500/40 bg-rose-500/10 p-4">
          <h2 className="text-sm font-semibold text-rose-300">
            Negative balance alert — {overdrawn.length} user(s) overdrawn
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr>
                  <Th>User</Th>
                  <Th>Email</Th>
                  <Th>Balance (credits)</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rose-500/20">
                {overdrawn.map((row) => (
                  <tr key={row.user_id}>
                    <Td>
                      <span className="font-mono text-xs text-zinc-400">{row.user_id}</span>
                    </Td>
                    <Td>{row.email}</Td>
                    <Td>
                      <span className="font-semibold text-rose-300">
                        {row.balance.toLocaleString()}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Requests (24h)" value={summary.requests.toLocaleString()} />
        <Stat
          label="Error rate"
          value={pct(summary.errors, summary.requests)}
          tone={summary.errors > 0 ? 'alert' : undefined}
        />
        <Stat
          label="p95 latency"
          value={summary.p95_latency_ms === null ? '—' : `${Math.round(summary.p95_latency_ms)} ms`}
        />
        <Stat label="Credits consumed" value={summary.credits.toLocaleString()} />
      </div>

      <Card title="Cost by channel (24h)">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr>
                <Th>Channel</Th>
                <Th>Requests</Th>
                <Th>Errors</Th>
                <Th>p95 latency</Th>
                <Th>Credits</Th>
                <Th>Cost (USD)</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {byChannel.length === 0 ? (
                <EmptyRow colSpan={6} label="No usage in the last 24 hours." />
              ) : (
                byChannel.map((row) => (
                  <tr key={row.channel_id}>
                    <Td>
                      <span className="font-mono text-xs">{row.channel_id}</span>
                    </Td>
                    <Td>{row.requests.toLocaleString()}</Td>
                    <Td>
                      <span className={row.errors > 0 ? 'text-rose-300' : undefined}>
                        {row.errors.toLocaleString()}
                      </span>
                    </Td>
                    <Td>{row.p95_latency_ms === null ? '—' : `${Math.round(row.p95_latency_ms)} ms`}</Td>
                    <Td>{row.credits.toLocaleString()}</Td>
                    <Td>{`$${row.cost_usd.toFixed(4)}`}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

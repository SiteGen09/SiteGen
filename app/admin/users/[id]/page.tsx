import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { requireAdmin } from '@/lib/api/admin';
import {
  USAGE_RANGES, parseUsageRange, parseUsageSort, recentRequests, usageMonitoring,
} from '@/lib/admin/usage-monitoring';
import { userAccount, userCreditHistory } from '@/lib/admin/user-monitoring';
import { sql } from '@/lib/db';

import { LiveRefresh } from '../../_components/live-refresh';
import { Badge, Card, EmptyRow, PageTitle, Stat, Td, Th } from '../../_components/ui';
import { ProfitSummary, RecentRequests, UsageFilters, UsageTable } from '../../_components/usage-monitor';
import { GrantForm } from '../_components/grant-form';
import { SuspendForm } from '../_components/suspend-form';

export const dynamic = 'force-dynamic';

function renderTime(): Date {
  return new Date();
}

const number = (value: number) => value.toLocaleString('en-US');
const date = (value: Date | null) => value === null ? '—' : value.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export default async function AdminUserPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const rawParams = await searchParams;
  const query = Object.fromEntries(Object.entries(rawParams).map(([key, value]) => [key, typeof value === 'string' ? value : undefined]));
  const range = parseUsageRange(query.range);
  const sort = parseUsageSort(query.sort);
  const basePath = '/admin/users/' + id;

  const now = renderTime();
  const [account, usage, recent, credits] = await Promise.all([
    userAccount(id),
    usageMonitoring(range, sort, sql, { userId: id }),
    recentRequests({ userId: id, limit: 25 }),
    userCreditHistory(id, 25),
  ]);
  if (account === null) notFound();
  const { summary } = usage;
  const period = USAGE_RANGES[range].toLowerCase();
  const details: [string, ReactNode][] = [
    ['Role', <Badge key="role" value={account.role} />],
    ['Access', <span key="access" className="flex flex-wrap items-center gap-2"><Badge value={account.status} />{account.billing_hold && <Link href="/admin/disputes" className="text-xs text-amber-400 underline">Billing freeze</Link>}</span>],
    ['Plan', account.plan_key ?? '—'],
    ['Subscription', account.entitlement_status === null ? '—' : <Badge key="subscription" value={account.entitlement_status} />],
    ['Period end', date(account.current_period_end)],
    ['Joined', date(account.created_at)],
    ['Last request', date(account.last_used_at)],
    ['Strikes 24h', <span key="strikes" className={account.strikes_24h > 0 ? 'font-semibold text-amber-400' : undefined}>{account.strikes_24h}</span>],
  ];

  return (
    <>
      <Link href="/admin/users" className="mb-3 inline-block text-sm text-zinc-400 underline underline-offset-4">← All users</Link>
      <PageTitle title={account.email} subtitle={account.id} />
      <LiveRefresh renderedAt={now.toISOString()} />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Balance" value={number(account.balance)} tone={account.balance < 0 ? 'alert' : undefined} />
        <Stat label="Reserved in flight" value={number(account.reserved)} />
        <Stat label={'Credits used · ' + range} value={number(summary.credits)} />
        <Stat label="Monthly plan credits" value={account.monthly_credits === null ? '—' : number(account.monthly_credits)} />
      </div>

      <Card title="Account">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
              <dd className="mt-1 text-zinc-200">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <h2 className="mb-4 mt-8 text-base font-semibold text-zinc-100">Usage</h2>
      <UsageFilters range={range} sort={sort} basePath={basePath} />
      <ProfitSummary totals={summary} />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Requests" value={number(summary.requests)} detail={number(summary.successful_requests) + ' successful'} />
        <Stat label="Error rate" value={summary.requests === 0 ? '0%' : ((summary.errors / summary.requests) * 100).toFixed(1) + '%'} tone={summary.errors > 0 ? 'alert' : undefined} />
        <Stat label="Tokens" value={number(summary.input_tokens + summary.output_tokens + summary.cached_tokens)} />
        <Stat label="p95 latency" value={summary.p95_latency_ms === null ? '—' : number(Math.round(summary.p95_latency_ms)) + ' ms'} />
      </div>

      <div className="space-y-5">
        <UsageTable rows={usage.models} kind="models" total={summary.requests} params={{ ...query, range, sort }} basePath={basePath} />
        <RecentRequests rows={recent} now={now} title="Recent requests" showUser={false} />

        <Card title="Credit history">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead><tr><Th>When</Th><Th>Kind</Th><Th>Credits</Th><Th>Reason / reference</Th></tr></thead>
              <tbody className="divide-y divide-zinc-800">
                {credits.length === 0 ? <EmptyRow colSpan={4} label="No top-ups, grants or refunds." /> : credits.map((entry) => (
                  <tr key={entry.id}>
                    <Td><span className="whitespace-nowrap">{date(entry.created_at)}</span></Td>
                    <Td><Badge value={entry.kind} /></Td>
                    <Td><span className={entry.credits < 0 ? 'text-rose-300' : 'text-emerald-300'}>{entry.credits > 0 ? '+' : ''}{number(entry.credits)}</span></Td>
                    <Td>
                      {entry.reason !== null && <div className="max-w-md break-words">{entry.reason}</div>}
                      <div className="max-w-md break-all font-mono text-xs text-zinc-500">{entry.request_id}</div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            Newest 25 entries. Per-request charges are listed under recent requests. <Link href={'/admin/orders?user=' + account.id} className="underline">Order history</Link>
          </p>
        </Card>

        <Card title="Admin actions">
          <div className="space-y-4 text-sm">
            <div>
              <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Grant credits</div>
              <GrantForm userId={account.id} />
            </div>
            <div>
              <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Suspend</div>
              <SuspendForm userId={account.id} suspended={account.status === 'suspended'} />
            </div>
          </div>
        </Card>
      </div>

      <p className="mt-5 text-xs leading-relaxed text-zinc-500">
        Usage figures cover the {period} and count failed and rejected requests. Revenue values this account&apos;s consumed credits at $0.0001 each; provider cost is what serving them cost you. Balance already has reserved credits subtracted; reserved credits return or settle when their requests finish.
      </p>
    </>
  );
}

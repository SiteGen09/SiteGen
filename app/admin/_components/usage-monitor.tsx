import Link from 'next/link';

import {
  USAGE_RANGES, USAGE_SORTS,
  type Consumer, type RecentRequest, type UsageBreakdown, type UsageMonitoring, type UsageRange, type UsageSort,
  type UsageTotals,
} from '@/lib/admin/usage-monitoring';
import { clampPage, pageSlice, parsePage, parsePageSize } from '@/lib/ui/pagination';
import { Card, EmptyRow, Pager, Stat, Td, Th } from './ui';

type Params = Record<string, string | undefined>;
type Money = Pick<UsageTotals,
  'revenue_usd' | 'provider_cost_usd' | 'profit_usd' | 'unpriced_revenue_usd' | 'unpriced_requests'
  | 'estimated_cost_requests' | 'byok_requests'>;
const number = (value: number) => value.toLocaleString('en-US');
const percent = (part: number, whole: number) => whole === 0 ? '0%' : ((part / whole) * 100).toFixed(1) + '%';

/**
 * US dollars. Totals use cents, or four places below $1 so early sub-cent
 * figures do not all read $0.00; `precise` gives six places for one request.
 */
export function usd(value: number, precise = false): string {
  const magnitude = Math.abs(value);
  const digits = precise ? 6 : magnitude > 0 && magnitude < 1 ? 4 : 2;
  return value.toLocaleString('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

/** Profit as a share of the revenue it was measured against (revenue with a known cost). */
export function margin(row: Money): string {
  const priced = row.revenue_usd - row.unpriced_revenue_usd;
  return priced <= 0 ? '—' : ((row.profit_usd / priced) * 100).toFixed(1) + '%';
}

function profitClass(value: number): string {
  return value > 0 ? 'text-emerald-300' : value < 0 ? 'text-rose-300' : 'text-zinc-200';
}

function RevenueCell({ row }: { row: Money & { credits: number } }) {
  return (
    <Td>
      <div className="whitespace-nowrap">{usd(row.revenue_usd)}</div>
      <div className="mt-1 whitespace-nowrap text-xs text-zinc-500">{number(row.credits)} credits</div>
    </Td>
  );
}

function CostCell({ row }: { row: Money }) {
  return (
    <Td>
      <div className="whitespace-nowrap">{usd(row.provider_cost_usd)}</div>
      {row.estimated_cost_requests > 0 && <div className="mt-1 whitespace-nowrap text-xs text-zinc-500">{number(row.estimated_cost_requests)} media estimated</div>}
      {row.byok_requests > 0 && <div className="mt-1 whitespace-nowrap text-xs text-zinc-500">{number(row.byok_requests)} BYOK at $0</div>}
      {row.unpriced_requests > 0 && <div className="mt-1 whitespace-nowrap text-xs text-amber-300">{number(row.unpriced_requests)} without cost</div>}
    </Td>
  );
}

function ProfitCell({ row }: { row: Money }) {
  return (
    <Td>
      <div className={'whitespace-nowrap font-medium ' + profitClass(row.profit_usd)}>{usd(row.profit_usd)}</div>
      <div className="mt-1 whitespace-nowrap text-xs text-zinc-500">{margin(row)} margin</div>
    </Td>
  );
}

/**
 * Revenue, provider cost, gross profit and margin for a period, with the
 * caveats that decide how far the profit figure can be trusted.
 */
export function ProfitSummary({ totals }: { totals: UsageTotals }) {
  const notes: { text: string; warn: boolean }[] = [];
  if (totals.unpriced_requests > 0) notes.push({ warn: true, text: number(totals.unpriced_requests) + ' requests earned ' + usd(totals.unpriced_revenue_usd) + ' but have no provider cost, so they are left out of profit and margin.' });
  if (totals.unearned_cost_requests > 0) notes.push({ warn: true, text: number(totals.unearned_cost_requests) + ' requests charged no credits but cost ' + usd(totals.unearned_cost_usd) + ': sources priced at 0×, or BYOK calls recorded before BYOK usage was marked.' });
  if (totals.estimated_cost_requests > 0) notes.push({ warn: false, text: number(totals.estimated_cost_requests) + " media requests use a provider cost recovered from the upstream's reported credits or the job's markup." });
  if (totals.byok_requests > 0) notes.push({ warn: false, text: number(totals.byok_requests) + " BYOK requests ran on customers' own keys: no revenue and no provider cost to you." });
  return (
    <div className="mb-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Revenue" value={usd(totals.revenue_usd)} detail={number(totals.credits) + ' credits consumed'} />
        <Stat label="Provider cost" value={usd(totals.provider_cost_usd)} detail="paid to AI providers" />
        <Stat label="Gross profit" value={usd(totals.profit_usd)} tone={totals.profit_usd < 0 ? 'alert' : totals.profit_usd > 0 ? 'good' : undefined} detail="revenue − provider cost" />
        <Stat label="Margin" value={margin(totals)} detail="of revenue with a known cost" />
      </div>
      {notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs leading-relaxed">
          {notes.map((note) => <li key={note.text} className={note.warn ? 'text-amber-300' : 'text-zinc-500'}>{note.text}</li>)}
        </ul>
      )}
    </div>
  );
}

function modelLabel(row: UsageBreakdown): string {
  return row.model_id ?? 'Unattributed';
}

function routeLabel(row: UsageBreakdown): string {
  return row.channel_label ?? row.channel_id ?? 'No channel recorded';
}

export function UsageTable({ rows, kind, total, params, basePath = '/admin' }: {
  rows: UsageBreakdown[];
  kind: 'models' | 'routes';
  total: number;
  params: Params;
  basePath?: string;
}) {
  const pageParam = kind === 'models' ? 'mpage' : 'rpage';
  const sizeParam = kind === 'models' ? 'msize' : 'rsize';
  const size = parsePageSize(params[sizeParam]);
  const page = clampPage(parsePage(params[pageParam]), rows.length, size);
  const visible = pageSlice(rows, page, size);
  return (
    <Card title={kind === 'models' ? 'Usage by model' : 'Usage by channel / route'}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[64rem] text-sm">
          <thead><tr>
            <Th>{kind === 'models' ? 'Model' : 'Model · channel · source'}</Th>
            <Th>Requests / share</Th><Th>Consumers</Th><Th>Tokens</Th>
            <Th>Revenue</Th><Th>Provider cost</Th><Th>Gross profit</Th><Th>Errors</Th><Th>p95 latency</Th>
          </tr></thead>
          <tbody className="divide-y divide-zinc-800">
            {visible.length === 0 ? <EmptyRow colSpan={9} label="No recorded usage in this period." /> : visible.map((row) => (
              <tr key={JSON.stringify([row.model_id, row.channel_id, row.channel_label, row.source_id, row.source_label, row.provider, row.task])}>
                <Td>
                  <div className="max-w-64 break-words font-medium text-zinc-100">{modelLabel(row)}</div>
                  {kind === 'routes' && <>
                    <div className="mt-1 max-w-64 break-words text-xs text-zinc-300">{routeLabel(row)}</div>
                    <div className="mt-1 max-w-64 break-words font-mono text-xs text-zinc-500">{row.channel_id ?? '—'}</div>
                    <div className="mt-1 text-xs text-zinc-400">{row.source_label ?? row.source_id ?? 'Unknown source'}</div>
                    <div className="mt-1 text-xs text-zinc-500">{[row.provider, row.task].filter(Boolean).join(' · ')}</div>
                  </>}
                </Td>
                <Td>
                  <div>{number(row.requests)}</div>
                  <div className="mt-1 text-xs text-zinc-400">{percent(row.requests, total)}</div>
                  <div aria-hidden="true" className="mt-1 h-1 w-20 overflow-hidden rounded bg-zinc-800">
                    <div className="h-full rounded bg-indigo-400" style={{ width: total === 0 ? '0%' : (row.requests / total * 100) + '%' }} />
                  </div>
                </Td>
                <Td>{number(row.consumers)}</Td>
                <Td>
                  <div>{number(row.input_tokens + row.output_tokens + row.cached_tokens)}</div>
                  <div className="mt-1 whitespace-nowrap text-xs text-zinc-500">{number(row.input_tokens)} in</div>
                  <div className="whitespace-nowrap text-xs text-zinc-500">{number(row.output_tokens)} out · {number(row.cached_tokens)} cached</div>
                </Td>
                <RevenueCell row={row} />
                <CostCell row={row} />
                <ProfitCell row={row} />
                <Td>
                  <span className={row.errors > 0 ? 'text-rose-300' : undefined}>{percent(row.errors, row.requests)}</span>
                  <div className="mt-1 text-xs text-zinc-500">{number(row.errors)} requests</div>
                </Td>
                <Td>{row.p95_latency_ms === null ? '—' : number(Math.round(row.p95_latency_ms)) + ' ms'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager basePath={basePath} page={page} pageSize={size} total={rows.length} label={kind}
        query={params} params={{ page: pageParam, size: sizeParam }} />
    </Card>
  );
}

export function UsageFilters({ range, sort, basePath = '/admin' }: { range: UsageRange; sort: UsageSort; basePath?: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <nav aria-label="Usage period" className="flex flex-wrap gap-2">
        {Object.entries(USAGE_RANGES).map(([key, label]) => (
          <Link key={key} href={basePath + '?range=' + key + '&sort=' + sort} aria-current={range === key ? 'page' : undefined}
            className={'rounded-md border px-3 py-2 text-sm ' + (range === key ? 'border-zinc-100 bg-zinc-100 font-medium text-zinc-900' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800')}>
            {label}
          </Link>
        ))}
      </nav>
      <form key={range + sort} method="get" action={basePath} className="flex items-center gap-2 text-sm">
        <input type="hidden" name="range" value={range} />
        <label htmlFor="usage-sort" className="text-zinc-400">Rank by</label>
        <select id="usage-sort" name="sort" defaultValue={sort} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-zinc-200">
          {Object.entries(USAGE_SORTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <button className="rounded-md border border-zinc-700 px-3 py-2 text-zinc-200 hover:bg-zinc-800" type="submit">Apply</button>
      </form>
    </div>
  );
}

export function UsageMonitor({ data, params }: { data: UsageMonitoring; params: Params }) {
  const topModel = [...data.models].filter((row) => row.model_id !== null).sort((a, b) => b.requests - a.requests)[0];
  const topRoute = [...data.routes].filter((row) => row.channel_id !== null).sort((a, b) => b.requests - a.requests)[0];
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        {[{ title: 'Most used model', row: topModel, label: topModel ? modelLabel(topModel) : 'No model usage yet' },
          { title: 'Most used channel / route', row: topRoute, label: topRoute ? routeLabel(topRoute) : 'No route usage yet' }].map(({ title, row, label }) => (
          <Card key={title} title={title}>
            <div className="break-words text-lg font-semibold text-zinc-50">{label}</div>
            {row && <p className="mt-2 text-sm text-zinc-400">{number(row.requests)} requests · {percent(row.requests, data.summary.requests)} of usage · {number(row.consumers)} consumers</p>}
            {row === topRoute && row && <p className="mt-1 break-words text-xs text-zinc-500">{modelLabel(row)} · {row.source_label ?? row.source_id ?? 'Unknown source'} · {row.channel_id}</p>}
          </Card>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-zinc-400">Compare demand, revenue and provider cost before adjusting prices.</p>
        <div className="flex flex-wrap gap-4">
          <Link href="/admin/channels" className="text-indigo-300 underline underline-offset-4">Manage channel prices</Link>
          <Link href="/admin/sources" className="text-indigo-300 underline underline-offset-4">Manage source markups</Link>
        </div>
      </div>
      <UsageTable rows={data.models} kind="models" total={data.summary.requests} params={params} />
      <UsageTable rows={data.routes} kind="routes" total={data.summary.requests} params={params} />
      <div className="space-y-2 text-xs leading-relaxed text-zinc-500">
        <p>Counts use recorded request outcomes, including failures and rejections. Consumers are unique accounts within each row; row counts may overlap. Successful requests are attributed to the serving channel after fallback. Failed requests show the channel recorded by the request handler. p95 uses successful requests only.</p>
        <p>Revenue values consumed credits at $0.0001 each, the top-up price. Provider cost is what serving each request cost at the channel&apos;s provider rates: zero for BYOK, and recovered for media jobs from the upstream&apos;s reported credits or the job&apos;s markup. Gross profit is revenue minus provider cost over requests whose cost is known. It is before payment-processor fees, and credits given away (grants, promo codes) count as revenue when spent. Tokens include input, output and cache reads; media requests may have no token counts.</p>
        {data.summary.legacy_requests > 0 && <p>{number(data.summary.legacy_requests)} older requests use current catalog model and channel labels because historical snapshots are unavailable. Unknown sources are kept unattributed. New usage preserves the model, channel and source labels recorded at settlement.</p>}
      </div>
    </div>
  );
}

function tokens(row: { input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null }): string {
  if (row.input_tokens === null && row.output_tokens === null && row.cached_tokens === null) return '—';
  return number((row.input_tokens ?? 0) + (row.output_tokens ?? 0) + (row.cached_tokens ?? 0));
}

function ago(date: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

const STATUS_CLASS: Record<string, string> = {
  ok: 'text-emerald-300',
  failed: 'text-rose-300',
  rejected: 'text-amber-300',
};

export function TopConsumers({ rows, range }: { rows: Consumer[]; range: UsageRange }) {
  return (
    <Card title={'Top consumers by revenue · ' + USAGE_RANGES[range].toLowerCase()}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[58rem] text-sm">
          <thead><tr>
            <Th>User</Th><Th>Revenue</Th><Th>Provider cost</Th><Th>Gross profit</Th>
            <Th>Balance</Th><Th>Requests</Th><Th>Tokens</Th><Th>Errors</Th>
          </tr></thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.length === 0 ? <EmptyRow colSpan={8} label="No recorded usage in this period." /> : rows.map((row) => (
              <tr key={row.user_id}>
                <Td>
                  <Link href={'/admin/users/' + row.user_id} className="break-all font-medium text-zinc-100 underline underline-offset-4">{row.email}</Link>
                </Td>
                <RevenueCell row={row} />
                <CostCell row={row} />
                <ProfitCell row={row} />
                <Td><span className={row.balance < 0 ? 'font-semibold text-rose-300' : undefined}>{number(row.balance)}</span></Td>
                <Td>{number(row.requests)}</Td>
                <Td>{number(row.tokens)}</Td>
                <Td><span className={row.errors > 0 ? 'text-rose-300' : undefined}>{percent(row.errors, row.requests)}</span></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function RecentRequests({ rows, now, title = 'Live activity', showUser = true }: {
  rows: RecentRequest[];
  /** Server render time, so "ago" labels agree with the data they describe. */
  now: Date;
  title?: string;
  showUser?: boolean;
}) {
  const columns = showUser ? 9 : 8;
  return (
    <Card title={title}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[64rem] text-sm">
          <thead><tr>
            <Th>When</Th>{showUser && <Th>User</Th>}<Th>Model</Th><Th>Status</Th>
            <Th>Tokens</Th><Th>Revenue</Th><Th>Provider cost</Th><Th>Profit</Th><Th>Latency</Th>
          </tr></thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.length === 0 ? <EmptyRow colSpan={columns} label="No requests recorded yet." /> : rows.map((row) => (
              <tr key={row.request_id}>
                <Td>
                  <div className="whitespace-nowrap">{ago(row.created_at, now)}</div>
                  <div className="mt-1 whitespace-nowrap text-xs text-zinc-500">{row.created_at.toISOString().slice(5, 19).replace('T', ' ')} UTC</div>
                </Td>
                {showUser && (
                  <Td>
                    <Link href={'/admin/users/' + row.user_id} className="break-all text-zinc-100 underline underline-offset-4">{row.email}</Link>
                  </Td>
                )}
                <Td>
                  <div className="max-w-56 break-words font-medium text-zinc-100">{row.model_id ?? 'Unattributed'}</div>
                  <div className="mt-1 max-w-56 break-words text-xs text-zinc-500">{[row.channel_label ?? row.channel_id, row.source_label].filter(Boolean).join(' · ') || 'No channel recorded'}</div>
                </Td>
                <Td><span className={STATUS_CLASS[row.status] ?? 'text-zinc-300'}>{row.status}</span></Td>
                <Td>{tokens(row)}</Td>
                <Td>
                  <div className="whitespace-nowrap">{usd(row.revenue_usd, true)}</div>
                  <div className="mt-1 whitespace-nowrap text-xs text-zinc-500">{number(row.credits_charged ?? 0)} credits</div>
                </Td>
                <Td>
                  <div className="whitespace-nowrap">{row.provider_cost_usd === null ? '—' : usd(row.provider_cost_usd, true)}</div>
                  {row.byok && <div className="mt-1 text-xs text-zinc-500">BYOK</div>}
                  {row.cost_estimated && <div className="mt-1 text-xs text-zinc-500">estimated</div>}
                  {row.provider_cost_usd === null && row.revenue_usd > 0 && <div className="mt-1 text-xs text-amber-300">no cost record</div>}
                </Td>
                <Td>
                  {row.provider_cost_usd === null ? '—' : (
                    <span className={'whitespace-nowrap ' + profitClass(row.revenue_usd - row.provider_cost_usd)}>{usd(row.revenue_usd - row.provider_cost_usd, true)}</span>
                  )}
                </Td>
                <Td><span className="whitespace-nowrap">{row.latency_ms === null ? '—' : number(row.latency_ms) + ' ms'}</span></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

import Link from 'next/link';
import {
  STATUS_WINDOW_HOURS,
  modelStatusHistory,
  type ModelHealth,
  type ModelStatusRow,
} from '@/lib/dashboard/model-status';
import { clampPage, pageSlice, parsePage, parsePageSize } from '@/lib/ui/pagination';
import { Card, EmptyRow, PageHeader, Pager, Stat, Table, formatTimestamp } from '../ui';

export const metadata = { title: 'Model status — sitegen' };

// Health is computed from live traffic, so this must never be cached.
export const dynamic = 'force-dynamic';

const HEAD = ['Model', 'Health', 'Requests', 'Errors', 'p95 latency', 'Last success'] as const;

const HEALTH_COPY: Record<ModelHealth, { label: string; dot: string; badge: string }> = {
  operational: {
    label: 'Operational',
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-700',
  },
  degraded: { label: 'Degraded', dot: 'bg-amber-500', badge: 'bg-amber-50 text-amber-700' },
  outage: { label: 'Outage', dot: 'bg-red-500', badge: 'bg-red-50 text-red-700' },
  idle: { label: 'No recent traffic', dot: 'bg-zinc-300', badge: 'bg-zinc-100 text-zinc-600' },
};

function HealthBadge({ health }: { health: ModelHealth }) {
  const copy = HEALTH_COPY[health];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium ${copy.badge}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${copy.dot}`} />
      {copy.label}
    </span>
  );
}

function errorCell(row: ModelStatusRow): string {
  if (row.failed === 0 && row.rejected === 0) return '—';
  const rate = row.errorRate === null ? '' : ` (${(row.errorRate * 100).toFixed(1)}%)`;
  const rejected = row.rejected === 0 ? '' : ` · ${row.rejected} rejected`;
  return `${row.failed}${rate}${rejected}`;
}

function latencyCell(row: ModelStatusRow): string {
  return row.p95LatencyMs === null
    ? '—'
    : `${Math.round(row.p95LatencyMs).toLocaleString('en-US')} ms`;
}

/** One line summarising the board, so the page answers "is anything broken?" first. */
function headline(rows: ModelStatusRow[]): string {
  const outage = rows.filter((row) => row.health === 'outage').length;
  const degraded = rows.filter((row) => row.health === 'degraded').length;
  if (outage > 0) return `${outage} model${outage === 1 ? '' : 's'} in outage`;
  if (degraded > 0) return `${degraded} model${degraded === 1 ? '' : 's'} degraded`;
  return rows.length === 0 || rows.every((row) => row.health === 'idle')
    ? 'Awaiting observations'
    : 'No measured outages';
}

export default async function StatusPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; size?: string }>;
}) {
  const [sp, { rows, sla }] = await Promise.all([searchParams, modelStatusHistory()]);
  const healthy = rows.filter((row) => row.health === 'operational').length;
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  // The headline stats and the observed SLA stay whole-fleet figures; only the
  // two per-model lists below are paged, and they page together so a model's
  // hourly strip and its summary row are always on the same screen.
  const size = parsePageSize(sp.size);
  const page = clampPage(parsePage(sp.page), rows.length, size);
  const visible = pageSlice(rows, page, size);

  return (
    <>
      <PageHeader
        title="Model status"
        description={`Serving health over the last ${STATUS_WINDOW_HOURS} hours, measured across all traffic on this gateway.`}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Stat
          label="Overall"
          value={headline(rows)}
          hint={`${healthy} of ${rows.length} operational`}
        />
        <Stat
          label={`Requests (${STATUS_WINDOW_HOURS}h)`}
          value={totalRequests.toLocaleString('en-US')}
          hint="All callers, every model"
        />
      </div>

      <Card className="mb-6">
        <div className="mb-4 flex flex-wrap justify-between gap-2">
          <h2 className="font-semibold text-zinc-900">Hourly availability · 24h</h2>
          <p className="text-sm text-zinc-600">
            Observed SLA: {sla === null ? 'No data' : sla.toFixed(2) + '%'}
          </p>
        </div>
        <div className="space-y-4">
          {visible.map((row) => (
            <div key={row.publicModelId}>
              <div className="mb-1 flex justify-between text-sm">
                <span>{row.publicModelId}</span>
                <span>
                  {row.availability === null ? 'No data' : row.availability.toFixed(2) + '%'}
                </span>
              </div>
              <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-1">
                {row.buckets.map((bucket) => (
                  <div
                    key={bucket.hour}
                    tabIndex={0}
                    role="img"
                    aria-label={bucket.hour + ': ' + HEALTH_COPY[bucket.health].label}
                    title={
                      bucket.hour +
                      ' · ' +
                      HEALTH_COPY[bucket.health].label +
                      ' · ' +
                      bucket.probes +
                      ' probes · ' +
                      bucket.requests +
                      ' requests'
                    }
                    className={'h-7 rounded-sm ' + HEALTH_COPY[bucket.health].dot}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-between text-xs text-zinc-500">
          <span>23 hours ago · UTC</span>
          <span>Current hour</span>
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Green: operational · Amber: degraded · Red: outage · Gray: no evidence. Availability is
          the percentage of observed model-hours that are operational; gray hours are excluded.
        </p>
      </Card>

      <Table head={HEAD} minWidth="min-w-[46rem]">
        {visible.length === 0 ? (
          <EmptyRow colSpan={HEAD.length}>No models are configured yet.</EmptyRow>
        ) : (
          visible.map((row) => (
            <tr key={row.publicModelId}>
              <td className="px-4 py-2.5">
                <span className="font-mono text-xs text-zinc-900">{row.publicModelId}</span>
                <span className="mt-0.5 block text-xs text-zinc-500">{row.label}</span>
              </td>
              <td className="whitespace-nowrap px-4 py-2.5">
                <HealthBadge health={row.health} />
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-zinc-600">
                {row.requests.toLocaleString('en-US')}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-zinc-600">
                {errorCell(row)}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-zinc-600">
                {latencyCell(row)}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600">
                {formatTimestamp(row.lastSuccessAt)}
              </td>
            </tr>
          ))
        )}
      </Table>
      <Pager
        basePath="/dashboard/status"
        page={page}
        pageSize={size}
        total={rows.length}
        label="models"
      />

      <Card className="mt-6">
        <p className="text-xs leading-relaxed text-zinc-500">
          <span className="font-medium text-zinc-700">How health is decided.</span> Over a rolling{' '}
          {STATUS_WINDOW_HOURS}-hour window: under 10% upstream failures is operational, 10% or more
          is degraded, 50% or more is an outage. A model needs at least 10 requests before the rate
          is trusted. Each hourly probe supplies ten observations toward that minimum, but a failed
          probe counts as only one failure. If every probe fails and no real request succeeds, the
          model is in outage. Hours with no evidence stay gray.{' '}
          <span className="font-medium text-zinc-700">Errors</span> counts upstream failures;
          rejected requests (bad input, moderation, or too few credits) are listed separately
          because they are not the model faltering. p95 latency covers successful requests only. See{' '}
          <Link href="/dashboard/models" className="underline hover:text-zinc-700">
            Models
          </Link>{' '}
          for pricing and availability.
        </p>
      </Card>
    </>
  );
}

import type { SourceUsage } from '@/lib/admin/metrics';
import { clampPage, pageSlice, type PageSize } from '@/lib/ui/pagination';
import { Card, EmptyRow, Pager, Td, Th } from '../_components/ui';

/**
 * Per-source load over the last 24 hours: how hard each upstream account was
 * worked and what it cost.
 *
 * Admin-only, and deliberately reported from our own settled usage rows rather
 * than from any upstream account API — this is what we actually served and
 * billed, which is the number an operator needs when a source misbehaves or a
 * margin looks wrong.
 */

const HEAD = [
  'Source',
  'Requests',
  'Errors',
  'p95',
  'Input tokens',
  'Output tokens',
  'Cost (USD)',
  'Credits',
  'Last used',
] as const;

function relativeTime(at: Date | null): string {
  if (at === null) return '—';
  const minutes = Math.round((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function errorCell(row: SourceUsage): string {
  if (row.errors === 0) return '—';
  const rate = row.requests === 0 ? 0 : (row.errors / row.requests) * 100;
  return `${row.errors} (${rate.toFixed(1)}%)`;
}

const number = (value: number): string => value.toLocaleString('en-US');

export function SourceUsageTable({
  rows,
  page,
  size,
  query,
}: {
  rows: readonly SourceUsage[];
  page: number;
  size: PageSize;
  query?: Readonly<Record<string, string | number | undefined>>;
}) {
  const current = clampPage(page, rows.length, size);
  const visible = pageSlice(rows, current, size);
  return (
    <Card title="Source usage · last 24 hours">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <thead>
            <tr>
              {HEAD.map((head) => (
                <Th key={head}>{head}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <EmptyRow colSpan={HEAD.length} label="No traffic in the last 24 hours." />
            ) : (
              visible.map((row) => (
                <tr key={row.source_id}>
                  <Td>
                    <span className="font-medium">{row.source_label}</span>
                    <span className="mt-0.5 block font-mono text-xs text-zinc-500">
                      {row.source_id}
                    </span>
                  </Td>
                  <Td>{number(row.requests)}</Td>
                  <Td>{errorCell(row)}</Td>
                  <Td>
                    {row.p95_latency_ms === null ? '—' : `${number(Math.round(row.p95_latency_ms))} ms`}
                  </Td>
                  <Td>{number(row.input_tokens)}</Td>
                  <Td>{number(row.output_tokens)}</Td>
                  <Td>${row.cost_usd.toFixed(4)}</Td>
                  <Td>{number(row.credits)}</Td>
                  <Td>{relativeTime(row.last_used_at)}</Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager
        basePath="/admin/sources"
        page={current}
        pageSize={size}
        total={rows.length}
        label="sources"
        query={query}
        params={{ page: 'upage', size: 'usize' }}
      />
      <p className="mt-3 text-xs text-zinc-500">
        Grouped by the source recorded on each usage row at settlement, so reassigning a channel or
        renaming a source never rewrites history. Rows from before source snapshots were introduced
        appear as <span className="font-mono">(unknown)</span>.
      </p>
    </Card>
  );
}

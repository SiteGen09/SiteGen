import { requireAdmin } from '@/lib/api/admin';
import { auditPage, type AuditEntry } from '@/lib/admin/metrics';
import { clampPage, pageQuery, parsePage, parsePageSize } from '@/lib/ui/pagination';

import { Card, EmptyRow, PageTitle, Pager, Td, Th } from '../_components/ui';

export const dynamic = 'force-dynamic';

function JsonCell({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-zinc-600">{label}: —</span>;
  }
  return (
    <details>
      <summary className="cursor-pointer text-xs text-zinc-400">{label}</summary>
      <pre className="mt-1 max-w-md overflow-x-auto rounded bg-zinc-950 p-2 text-xs text-zinc-300">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <tr>
      <Td>
        <span className="text-xs text-zinc-500">{entry.created_at.toLocaleString()}</span>
      </Td>
      <Td>{entry.actor_email ?? <span className="font-mono text-xs">{entry.actor_id}</span>}</Td>
      <Td>
        <span className="font-mono text-xs text-zinc-100">{entry.action}</span>
      </Td>
      <Td>
        <span className="font-mono text-xs">{entry.target}</span>
      </Td>
      <Td>
        <div className="flex flex-col gap-1">
          <JsonCell label="before" value={entry.before} />
          <JsonCell label="after" value={entry.after} />
        </div>
      </Td>
    </tr>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; size?: string }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const size = parsePageSize(sp.size);
  const requested = parsePage(sp.page);
  const first = pageQuery(requested, size);
  const { entries, total } = await auditPage(first.limit, first.offset);
  // The log only grows, but a bookmarked `?page=` can still outrun a shrunk
  // page size; land on the last real page rather than on an empty table.
  const page = clampPage(requested, total, size);
  let rows = entries;
  if (page !== requested) {
    const corrected = pageQuery(page, size);
    rows = (await auditPage(corrected.limit, corrected.offset)).entries;
  }

  return (
    <>
      <PageTitle title="Audit log" subtitle="Every privileged admin action, newest first." />

      <Card title="Actions">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Target</Th>
                <Th>Change</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.length === 0 ? (
                <EmptyRow colSpan={5} label="No audit entries." />
              ) : (
                rows.map((entry) => <AuditRow key={entry.id} entry={entry} />)
              )}
            </tbody>
          </table>
        </div>
        <Pager basePath="/admin/audit" page={page} pageSize={size} total={total} label="entries" />
      </Card>
    </>
  );
}

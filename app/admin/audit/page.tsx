import { requireAdmin } from '@/lib/api/admin';
import { auditPage, type AuditEntry } from '@/lib/admin/metrics';

import { Card, EmptyRow, PageTitle, Pager, Td, Th } from '../_components/ui';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

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
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const { entries, total } = await auditPage(PAGE_SIZE, (page - 1) * PAGE_SIZE);

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
              {entries.length === 0 ? (
                <EmptyRow colSpan={5} label="No audit entries." />
              ) : (
                entries.map((entry) => <AuditRow key={entry.id} entry={entry} />)
              )}
            </tbody>
          </table>
        </div>
        <Pager basePath="/admin/audit" page={page} pageSize={PAGE_SIZE} total={total} />
      </Card>
    </>
  );
}

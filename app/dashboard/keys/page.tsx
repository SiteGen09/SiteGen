import { listApiKeys } from '@/lib/dashboard/queries';
import { clampPage, pageSlice, parsePage, parsePageSize } from '@/lib/ui/pagination';
import { EmptyRow, PageHeader, Pager, StatusBadge, Table, formatTimestamp } from '../ui';
import { CreateKeyForm, RevokeKeyForm } from './key-forms';

export const metadata = { title: 'API keys — sitegen' };

const HEAD = ['Name', 'Key', 'Status', 'Rate limit', 'Last used', 'Created', ''] as const;

export default async function KeysPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; size?: string }>;
}) {
  const [sp, keys] = await Promise.all([searchParams, listApiKeys()]);
  const size = parsePageSize(sp.size);
  const page = clampPage(parsePage(sp.page), keys.length, size);
  const visible = pageSlice(keys, page, size);

  return (
    <>
      <PageHeader
        title="API keys"
        description="Authenticate requests with Authorization: Bearer <key>. Keys are shown once at creation."
      />

      <div className="mb-8 rounded-lg border border-zinc-200 bg-white p-4 sm:p-5">
        <CreateKeyForm />
      </div>

      <Table head={HEAD} minWidth="min-w-[48rem]">
        {visible.length === 0 ? (
          <EmptyRow colSpan={HEAD.length}>No keys yet.</EmptyRow>
        ) : (
          visible.map((key) => (
            <tr key={key.id}>
              <td className="px-4 py-2.5 text-zinc-900">{key.name}</td>
              <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-zinc-600">
                {key.key_prefix}…{key.last_four}
              </td>
              <td className="px-4 py-2.5">
                <StatusBadge status={key.status} />
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-zinc-600">
                {key.rate_limit_rpm}/min
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600">
                {formatTimestamp(key.last_used_at)}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600">
                {formatTimestamp(key.created_at)}
              </td>
              <td className="px-4 py-2.5 text-right">
                {key.status === 'active' && <RevokeKeyForm id={key.id} />}
              </td>
            </tr>
          ))
        )}
      </Table>
      <Pager
        basePath="/dashboard/keys"
        page={page}
        pageSize={size}
        total={keys.length}
        label="keys"
      />
    </>
  );
}

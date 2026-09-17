import { listCredentials } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import { EmptyRow, PageHeader, StatusBadge, Table, formatTimestamp } from '../ui';
import { AddCredentialForm, RevokeCredentialForm } from './credential-forms';

export const metadata = { title: 'Credentials — sitegen' };

const HEAD = ['Provider', 'Base URL', 'Key', 'Status', 'Added', ''] as const;

export default async function CredentialsPage() {
  const user = await requireUser();
  const credentials = await listCredentials(user.id);

  return (
    <>
      <PageHeader
        title="Provider credentials"
        description="Bring your own key. Keys are verified against the provider, then stored encrypted — only the last four digits are ever shown again."
      />

      <div className="mb-8 rounded-lg border border-zinc-200 bg-white p-4 sm:p-5">
        <AddCredentialForm />
      </div>

      <Table head={HEAD} minWidth="min-w-[42rem]">
        {credentials.length === 0 ? (
          <EmptyRow colSpan={HEAD.length}>
            No credentials. Platform channels are used until you add one.
          </EmptyRow>
        ) : (
          credentials.map((credential) => (
            <tr key={credential.id}>
              <td className="px-4 py-2.5 text-zinc-900">{credential.provider}</td>
              <td className="px-4 py-2.5 font-mono text-xs text-zinc-600">
                {credential.base_url ?? '—'}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-zinc-600">
                ••••{credential.last_four}
              </td>
              <td className="px-4 py-2.5">
                <StatusBadge status={credential.status} />
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600">
                {formatTimestamp(credential.created_at)}
              </td>
              <td className="px-4 py-2.5 text-right">
                {credential.status === 'active' && <RevokeCredentialForm id={credential.id} />}
              </td>
            </tr>
          ))
        )}
      </Table>
    </>
  );
}

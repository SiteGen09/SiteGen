import { Fragment } from 'react';
import { z } from 'zod';

import { requireAdmin } from '@/lib/api/admin';
import { createServiceClient } from '@/lib/supabase/service';
import { clampPage, pageSlice, parsePage, parsePageSize } from '@/lib/ui/pagination';

import { Badge, Card, EmptyRow, PageTitle, Pager, Td, Th } from '../_components/ui';
import { BUTTON_SUBTLE_CLASS } from '../_components/action-state';
import { AddCredentialForm, RotateCredentialForm } from './_components/credential-forms';
import { revokeCredentialAction } from './actions';

export const dynamic = 'force-dynamic';

const credentialRowSchema = z.object({
  id: z.string(),
  provider: z.string(),
  base_url: z.string().nullable(),
  last_four: z.string(),
  status: z.string(),
  created_at: z.union([z.string(), z.date()]),
});

const COLS = 6;

export default async function CredentialsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; size?: string }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const size = parsePageSize(sp.size);
  const service = createServiceClient();
  const { data, error } = await service
    .from('provider_credentials')
    .select('id, provider, base_url, last_four, status, created_at')
    .is('owner_id', null)
    .order('created_at', { ascending: false });

  if (error !== null) {
    throw new Error(`failed to load credentials: ${error.message}`);
  }

  const all = z.array(credentialRowSchema).parse(data ?? []);
  const page = clampPage(parsePage(sp.page), all.length, size);
  const rows = pageSlice(all, page, size);

  return (
    <>
      <PageTitle
        title="Platform credentials"
        subtitle="Provider keys used to serve platform channels. Secrets are validated live, encrypted at rest, and never returned to the browser."
      />

      <div className="mb-6">
        <Card>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-zinc-200">
              Add credential
            </summary>
            <div className="mt-4">
              <AddCredentialForm />
            </div>
          </details>
        </Card>
      </div>

      <Card title="Credentials">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <thead>
              <tr>
                <Th>Provider</Th>
                <Th>Base URL</Th>
                <Th>Last four</Th>
                <Th>Status</Th>
                <Th>Created</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.length === 0 ? (
                <EmptyRow colSpan={COLS} label="No platform credentials." />
              ) : (
                rows.map((row) => (
                  <Fragment key={row.id}>
                    <tr>
                      <Td>
                        <span className="font-mono text-xs">{row.provider}</span>
                      </Td>
                      <Td>
                        <span className="font-mono text-xs">{row.base_url ?? '—'}</span>
                      </Td>
                      <Td>
                        <span className="font-mono text-xs">…{row.last_four}</span>
                      </Td>
                      <Td>
                        <Badge value={row.status} />
                      </Td>
                      <Td>
                        <span className="text-xs text-zinc-500">
                          {new Date(row.created_at).toLocaleString()}
                        </span>
                      </Td>
                      <Td>
                        {row.status === 'active' && (
                          <form action={revokeCredentialAction}>
                            <input type="hidden" name="id" value={row.id} />
                            <button type="submit" className={BUTTON_SUBTLE_CLASS}>
                              Revoke
                            </button>
                          </form>
                        )}
                      </Td>
                    </tr>
                    {row.status === 'active' && (
                      <tr>
                        <td colSpan={COLS} className="px-3 pb-4">
                          <details>
                            <summary className="cursor-pointer text-xs font-medium text-zinc-400">
                              Rotate {row.provider} …{row.last_four}
                            </summary>
                            <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/50 p-4">
                              <RotateCredentialForm
                                credentialId={row.id}
                                provider={row.provider}
                                baseUrl={row.base_url ?? ''}
                              />
                            </div>
                          </details>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager
          basePath="/admin/credentials"
          page={page}
          pageSize={size}
          total={all.length}
          label="credentials"
        />
      </Card>
    </>
  );
}

import { revokeRedemptionCode } from './actions';
import Link from 'next/link';
import { requireAdmin } from '@/lib/api/admin';
import { sql } from '@/lib/db';
import { Card, EmptyRow, PageTitle, Td, Th } from '../_components/ui';
import { CreateRedemptionCodeForm } from './_components/create-form';

export const dynamic = 'force-dynamic';

export default async function RedemptionCodesPage({searchParams}: {searchParams:Promise<{page?:string}>}) {
  await requireAdmin();
  const params = await searchParams;
  const page = Math.max(1,Math.min(100000,Math.floor(Number(params.page)||1)));
  const codes = await sql<{ id: string; code_prefix: string; label: string | null; credits: number; max_redemptions: number; redemption_count: number; expires_at: Date | null; active: boolean; expired: boolean; created_at: Date }[]>`
    SELECT id, code_prefix, label, credits, max_redemptions, redemption_count, expires_at, active, created_at, coalesce(expires_at <= now(), false) AS expired
    FROM credit_redemption_codes
    ORDER BY created_at DESC,id DESC
    LIMIT 26 OFFSET ${(page-1)*25}
  `;
  return (
    <>
      <PageTitle title="Redemption codes" subtitle="Issue prepaid credits without exposing the stored code values." />
      <Card title="Create a code">
        <CreateRedemptionCodeForm />
      </Card>
      <Card title="Issued codes">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[55rem] text-sm">
            <thead><tr><Th>Code</Th><Th>Label</Th><Th>Credits</Th><Th>Redemptions</Th><Th>Expires</Th><Th>Status</Th><Th>Created</Th></tr></thead>
            <tbody className="divide-y divide-zinc-800">
              {codes.length === 0 ? <EmptyRow colSpan={7} label="No redemption codes yet." /> : codes.slice(0,25).map((code) => {
                const expired = code.expired;
                const exhausted = code.redemption_count >= code.max_redemptions;
                return <tr key={code.id}>
                  <Td><span className="font-mono text-zinc-100">{code.code_prefix}...</span></Td>
                  <Td>{code.label ?? '—'}</Td>
                  <Td>{Number(code.credits).toLocaleString()}</Td>
                  <Td><div>{code.redemption_count.toLocaleString()} / {code.max_redemptions.toLocaleString()}</div><Link href={'/admin/redemption-codes/'+code.id} className="mt-1 inline-block text-xs underline" aria-label={'View redemptions for '+code.code_prefix}>View redemptions</Link></Td>
                  <Td>{code.expires_at?.toLocaleString() ?? 'Never'}</Td>
                  <Td>{!code.active ? 'Revoked' : expired ? 'Expired' : exhausted ? 'Used up' : 'Available'}</Td>
                  <Td>{code.created_at.toLocaleString()}{code.active && <form action={revokeRedemptionCode}><input type="hidden" name="id" value={code.id} /><button className="mt-2 underline text-red-400">Revoke code</button></form>}</Td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <nav className="mt-4 flex gap-4 text-sm">{page>1 && <Link href={'?page='+(page-1)}>Previous</Link>}<span>Page {page}</span>{codes.length>25 && <Link href={'?page='+(page+1)}>Next</Link>}</nav>
    </>
  );
}

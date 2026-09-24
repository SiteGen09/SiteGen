import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireAdmin } from '@/lib/api/admin';
import { sql } from '@/lib/db';
import { Card, EmptyRow, PageTitle, Td, Th } from '../../_components/ui';

export const dynamic = 'force-dynamic';

export default async function CodeRedemptionsPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const codes = await sql<{ code_prefix: string; label: string | null; redemption_count: number; max_redemptions: number }[]>`
    SELECT code_prefix,label,redemption_count,max_redemptions FROM credit_redemption_codes WHERE id=${id}
  `;
  const code = codes[0];
  if (!code) notFound();
  const query = await searchParams;
  const counts = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM credit_code_redemptions WHERE code_id=${id}`;
  const total = counts[0]!.total;
  const pages = Math.max(1,Math.ceil(total/25));
  const page = Math.min(pages,Math.max(1,Math.floor(Number(query.page)||1)));
  const redemptions = await sql<{ id: string; user_id: string; email: string | null; credits: number; redeemed_at: Date | string }[]>`
    SELECT r.id,r.user_id,p.email,r.credits,r.redeemed_at
    FROM credit_code_redemptions r LEFT JOIN profiles p ON p.id=r.user_id
    WHERE r.code_id=${id}
    ORDER BY r.redeemed_at DESC,r.id DESC LIMIT 25 OFFSET ${(page-1)*25}
  `;
  return <>
    <PageTitle title="Code redemption history" subtitle="See who redeemed this code and the credits delivered to each account." />
    <Link href="/admin/redemption-codes" className="mb-5 inline-block text-sm underline">Back to redemption codes</Link>
    <Card title={code.label ?? 'Redemption code'}>
      <p className="font-mono text-sm">{code.code_prefix}…</p>
      <p className="mt-2 text-sm text-zinc-400">{code.redemption_count.toLocaleString('en-US')} of {code.max_redemptions.toLocaleString('en-US')} redemptions used.</p>
      <p className="mt-1 text-xs text-zinc-500">Deleted accounts are removed from this list. The total used still includes their redemptions.</p>
    </Card>
    <Card title="Redeemed by">
      <div className="overflow-x-auto"><table className="w-full min-w-[45rem] text-sm">
        <thead><tr><Th>Customer</Th><Th>Account ID</Th><Th>Credits received</Th><Th>Redeemed at (UTC)</Th><Th>History</Th></tr></thead>
        <tbody className="divide-y divide-zinc-800">{redemptions.length === 0 ? <EmptyRow colSpan={5} label="No redemption records for this code." /> : redemptions.map(row => <tr key={row.id}>
          <Td>{row.email ?? 'Email unavailable'}</Td>
          <Td><span className="font-mono text-xs">{row.user_id}</span></Td>
          <Td>{Number(row.credits).toLocaleString('en-US')}</Td>
          <Td>{new Date(row.redeemed_at).toISOString().slice(0,19).replace('T',' ')}</Td>
          <Td><Link href={'/admin/orders?user='+row.user_id} className="underline">Customer orders</Link></Td>
        </tr>)}</tbody>
      </table></div>
    </Card>
    <nav aria-label="Code redemption history pages" className="mt-4 flex gap-4 text-sm">
      {page>1 && <Link href={'?page='+(page-1)}>Previous</Link>}
      <span>{total.toLocaleString('en-US')} records · Page {page} of {pages}</span>
      {page<pages && <Link href={'?page='+(page+1)}>Next</Link>}
    </nav>
  </>;
}

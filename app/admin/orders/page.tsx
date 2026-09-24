import Link from 'next/link';
import { z } from 'zod';
import { requireAdmin } from '@/lib/api/admin';
import { orderHistory } from '@/lib/billing/reports';
import { formatUsd } from '@/lib/billing/catalog';
import { PageTitle, Card, Th, Td, EmptyRow } from '../_components/ui';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ q?: string; user?: string; kind?: string; disputed?: string; page?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const userId = z.uuid().safeParse(params.user).data;
  const kind = ['topup','subscription'].includes(params.kind ?? '') ? params.kind : undefined;
  const result = await orderHistory({ userId, search: params.q, kind, disputed: params.disputed === '1', page: Math.max(1, Math.min(100000, Math.floor(Number(params.page) || 1))) });
  const link = (page: number) => '?' + new URLSearchParams({ q: params.q ?? '', user: userId ?? '', kind: kind ?? '', disputed: params.disputed ?? '', page: String(page) });
  return <><PageTitle title="Orders" subtitle="Verified payments and refunds. Select a customer to see their order history." />
    <form className="mb-6 flex flex-wrap gap-3">{userId && <input type="hidden" name="user" value={userId} />}
      <input name="q" defaultValue={params.q} aria-label="Search email or payment ID" placeholder="Email or payment ID" className="rounded border border-zinc-700 bg-zinc-900 p-2" />
      <select name="kind" defaultValue={kind ?? ''} aria-label="Purchase type" className="rounded bg-zinc-900 p-2"><option value="">All purchases</option><option value="topup">Top-ups</option><option value="subscription">Subscriptions</option></select>
      <label className="p-2"><input type="checkbox" name="disputed" value="1" defaultChecked={params.disputed === '1'} /> Disputed</label>
      <button className="rounded border border-zinc-600 px-4">Filter</button><Link href="/admin/orders" className="p-2 underline">Reset</Link>
    </form>
    <Card><div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-sm"><thead><tr>{['Date (UTC)','Customer','Payment','Type','Charged','Net credits','Status','Dispute'].map(h => <Th key={h}>{h}</Th>)}</tr></thead>
      <tbody>{!result.rows.length ? <EmptyRow colSpan={8} label="No matching orders." /> : result.rows.map(row => <tr key={row.id}>
        <Td>{row.created_at.toISOString().slice(0,16).replace('T',' ')}</Td><Td>{row.user_id ? <Link className="underline" href={'?user='+row.user_id}>{row.email}</Link> : 'Deleted account'}</Td>
        <Td><span className="font-mono text-xs">{row.payment_id}</span></Td><Td>{row.kind}</Td><Td>{formatUsd(row.total_cents)}</Td>
        <Td>{Number(row.credits_granted-row.credits_reversed).toLocaleString('en-US')}</Td><Td>{row.status}</Td><Td>{row.dispute_status}</Td>
      </tr>)}</tbody></table></div></Card>
    <nav className="mt-4 flex gap-4 text-sm">{result.page>1 && <Link href={link(result.page-1)}>Previous</Link>}<span>{result.total} orders · Page {result.page} of {result.pages}</span>{result.page<result.pages && <Link href={link(result.page+1)}>Next</Link>}</nav>
  </>;
}

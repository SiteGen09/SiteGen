import Link from 'next/link';
import { requireUser } from '@/lib/dashboard/session';
import { orderHistory } from '@/lib/billing/reports';
import { formatUsd } from '@/lib/billing/catalog';
import { sql } from '@/lib/db';
import { PageHeader } from '../../ui';

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ page?: string; codes?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const page = Math.max(1, Math.min(100000, Number(params.page) || 1));
  const codePage = Math.max(1, Math.min(100000, Math.floor(Number(params.codes) || 1)));
  const { rows, page: current, pages } = await orderHistory({ userId: user.id, page: Math.floor(page) });
  const codes = await sql`SELECT id,credits,redeemed_at AS created_at,meta->>'code_prefix' AS prefix FROM credit_code_redemptions
    WHERE user_id=${user.id} ORDER BY redeemed_at DESC,id DESC LIMIT 26 OFFSET ${(codePage - 1) * 25}`;
  return <><PageHeader title="Order history" description="Your payments, refund adjustments, and redeemed credits." />
    <Link href="/dashboard/billing" className="text-sm underline">Back to billing</Link>
    <div className="my-6 overflow-x-auto"><table className="w-full min-w-[750px] text-left text-sm">
      <thead><tr>{['Date (UTC)', 'Payment', 'Purchase', 'Charged', 'Net credits', 'Status'].map(h => <th key={h} className="p-3">{h}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.id} className="border-t border-zinc-200">
        <td className="p-3">{row.created_at.toISOString().slice(0,16).replace('T',' ')}</td><td className="p-3 font-mono text-xs">{row.payment_id}</td>
        <td className="p-3">{row.kind}</td><td className="p-3">{formatUsd(row.total_cents)} USD</td>
        <td className="p-3">{Number(row.credits_granted-row.credits_reversed).toLocaleString('en-US')}</td>
        <td className="p-3">{row.status.replaceAll('_',' ')}{row.dispute_status !== 'none' && ' · dispute: ' + row.dispute_status.replaceAll('_',' ')}</td>
      </tr>)}</tbody></table>{rows.length === 0 && <p className="p-4 text-sm text-zinc-500">No payments yet.</p>}</div>
    <nav className="flex gap-4 text-sm" aria-label="Payment history pages">{current > 1 && <Link href={`?page=${current-1}&codes=${codePage}`}>Previous</Link>}<span>Page {current} of {pages}</span>{current < pages && <Link href={`?page=${current+1}&codes=${codePage}`}>Next</Link>}</nav>
    <h2 className="mt-10 font-semibold">Redemption history</h2>
    {codes.length ? <ul className="mt-3 divide-y divide-zinc-200">{codes.slice(0,25).map(code => <li key={code.id} className="py-3 text-sm">{new Date(code.created_at).toISOString().slice(0,10)} · {code.prefix}… · {Number(code.credits).toLocaleString('en-US')} credits</li>)}</ul> : <p className="mt-3 text-sm text-zinc-500">No codes redeemed yet.</p>}
    <nav className="mt-4 flex gap-4 text-sm" aria-label="Redemption history pages">{codePage > 1 && <Link href={`?page=${current}&codes=${codePage-1}`}>Previous codes</Link>}{codes.length > 25 && <Link href={`?page=${current}&codes=${codePage+1}`}>More codes</Link>}</nav>
  </>;
}

import Link from 'next/link';
import { requireAdmin } from '@/lib/api/admin';
import { billingLeaderboard } from '@/lib/billing/reports';
import { PageTitle, Card, Th, Td, EmptyRow } from '../_components/ui';

export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<{ sort?: string; page?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const sort = ['topups','subscriptions'].includes(params.sort ?? '') ? params.sort! : 'balance';
  const page = Math.max(1, Math.min(100000, Math.floor(Number(params.page) || 1)));
  const rows = await billingLeaderboard(sort,page);
  const credits = (value: number) => Number(value).toLocaleString('en-US');
  return <><PageTitle title="Credit leaderboard" subtitle="Private admin ranking. Paid credits include bonuses and subtract refunded credits; promotional codes count only toward current balance." />
    <nav className="mb-5 flex gap-4 text-sm">{[['balance','Current balance'],['topups','Top-up credits'],['subscriptions','Subscription credits']].map(([key,label]) => <Link className={sort === key ? 'font-semibold underline' : ''} key={key} href={'?sort='+key}>{label}</Link>)}</nav>
    <Card><div className="overflow-x-auto"><table className="w-full min-w-[850px] text-sm"><thead><tr>{['Rank','Customer','Balance','Top-up credits','Subscription credits','Orders','Current subscription','Access'].map(h => <Th key={h}>{h}</Th>)}</tr></thead>
      <tbody>{rows.length === 0 ? <EmptyRow colSpan={8} label="No customers yet." /> : rows.slice(0,25).map((row,index) => <tr key={row.id}>
        <Td>{(page-1)*25+index+1}</Td><Td><Link className="underline" href={'/admin/orders?user='+row.id}>{row.email}</Link></Td><Td>{credits(row.balance)}</Td><Td>{credits(row.topups)}</Td><Td>{credits(row.subscriptions)}</Td><Td>{credits(row.orders)}</Td><Td>{row.plan} · {row.status}</Td><Td>{row.billing_hold ? 'Billing freeze' : 'No billing freeze'}</Td>
      </tr>)}</tbody></table></div></Card>
    <nav className="mt-4 flex gap-4 text-sm">{page>1 && <Link href={`?sort=${sort}&page=${page-1}`}>Previous</Link>}<span>Page {page}</span>{rows.length>25 && <Link href={`?sort=${sort}&page=${page+1}`}>Next</Link>}</nav>
  </>;
}

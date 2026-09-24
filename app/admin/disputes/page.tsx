import Link from 'next/link';
import { requireAdmin } from '@/lib/api/admin';
import { sql } from '@/lib/db';
import { formatUsd } from '@/lib/billing/catalog';
import { PageTitle, Card } from '../_components/ui';
import { ReviewForm } from './review-form';

export default async function DisputesPage({searchParams}: {searchParams:Promise<{page?:string}>}) {
  await requireAdmin();
  const params = await searchParams;
  const page = Math.max(1,Math.min(100000,Math.floor(Number(params.page)||1)));
  const rows = await sql`SELECT d.*,p.email,p.billing_hold FROM billing_disputes d LEFT JOIN profiles p ON p.id=d.user_id
    ORDER BY (d.reviewed_at IS NULL) DESC,d.created_at DESC,d.id DESC LIMIT 26 OFFSET ${(page-1)*25}`;
  return <><PageTitle title="Disputes and account freezes" subtitle="Disputes freeze new AI usage, purchases, and code redemption. Won or closed cases require an audited review before access resumes." />
    <a href="https://whop.com/dashboard/" target="_blank" rel="noreferrer" className="mb-6 inline-block text-sm underline">Open Whop to submit evidence or manage the dispute</a>
    {!rows.length && <Card>No disputes recorded.</Card>}
    <div className="grid gap-4 md:grid-cols-2">{rows.slice(0,25).map(row => <Card key={row.id} title={row.email ?? 'Deleted account'}>
      <dl className="space-y-2 text-sm"><div><dt className="text-zinc-500">Dispute</dt><dd className="break-all font-mono text-xs">{row.provider_dispute_id}</dd></div>
        <div><dt className="text-zinc-500">Payment</dt><dd><Link className="underline" href={'/admin/orders?q='+encodeURIComponent(row.payment_id)}>{row.payment_id}</Link></dd></div>
        <div><dt className="text-zinc-500">Amount and status</dt><dd>{formatUsd(row.amount_cents)} USD · {row.status}</dd></div>
        <div><dt className="text-zinc-500">Reason</dt><dd>{row.reason ?? 'Not supplied'}</dd></div>
        <div><dt className="text-zinc-500">Evidence due (UTC)</dt><dd>{row.evidence_due_at ? new Date(row.evidence_due_at).toISOString() : 'See Whop'}</dd></div>
        <div><dt className="text-zinc-500">Account</dt><dd>{row.billing_hold ? 'Frozen for billing review' : 'No billing freeze'}</dd></div>
      </dl>
      {row.reviewed_at ? <p className="mt-4 text-sm">Reviewed: {row.review_note}</p> : ['won','closed','warning_closed'].includes(row.status) && row.user_id ? <ReviewForm id={row.id} /> : <p className="mt-4 text-xs text-amber-400">Hold remains while the dispute is unresolved or lost.</p>}
    </Card>)}</div>
    <nav className="mt-5 flex gap-4 text-sm">{page>1 && <Link href={'?page='+(page-1)}>Previous</Link>}<span>Page {page}</span>{rows.length>25 && <Link href={'?page='+(page+1)}>Next</Link>}</nav>
  </>;
}

import Link from 'next/link';

import { requireAdmin } from '@/lib/api/admin';
import { assistantSpend, listQueue, queueCounts } from '@/lib/support/tickets';
import { categoryLabel, priorityLabel, TICKET_STATUSES, type TicketStatus } from '@/lib/support/types';
import { clampPage, pageQuery, parsePage, parsePageSize } from '@/lib/ui/pagination';
import { LiveRefresh } from '../_components/live-refresh';
import { Badge, Card, EmptyRow, PageTitle, Pager, Stat, Td, Th } from '../_components/ui';
import { INPUT_CLASS } from '../_components/action-state';

export const dynamic = 'force-dynamic';

const FILTERS: { value: TicketStatus | 'all'; label: string }[] = [
  { value: 'open', label: 'Waiting on us' },
  { value: 'answered', label: 'Answered' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

const PRIORITY_TONE: Record<string, string> = {
  urgent: 'text-rose-300',
  high: 'text-amber-300',
  normal: 'text-zinc-300',
  low: 'text-zinc-500',
};

function age(date: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export default async function SupportQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string; size?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const status = (TICKET_STATUSES as readonly string[]).includes(sp.status ?? '') || sp.status === 'all'
    ? (sp.status as TicketStatus | 'all')
    : 'open';
  const query = (sp.q ?? '').slice(0, 120);
  const size = parsePageSize(sp.size ?? '25');
  const requested = parsePage(sp.page);
  const filter = { status, query };

  const first = pageQuery(requested, size);
  const [counts, spend, firstPage] = await Promise.all([
    queueCounts(),
    assistantSpend(30),
    listQueue(filter, first.limit, first.offset),
  ]);
  const page = clampPage(requested, firstPage.total, size);
  const { rows, total } = page === requested
    ? firstPage
    : await listQueue(filter, pageQuery(page, size).limit, pageQuery(page, size).offset);

  return (
    <>
      <PageTitle
        title="Support requests"
        subtitle="Customer requests from the dashboard's Contact support form, and the setup assistant's running cost."
      />
      <LiveRefresh renderedAt={new Date().toISOString()} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Waiting on us" value={counts.open.toLocaleString()} tone={counts.open > 0 ? 'alert' : undefined} />
        <Stat label="Answered" value={counts.answered.toLocaleString()} />
        <Stat label="Assistant answers 30d" value={spend.answers.toLocaleString()} detail={`${spend.users.toLocaleString()} customers`} />
        <Stat label="Assistant cost 30d" value={`$${spend.costUsd.toFixed(spend.costUsd >= 1 ? 2 : 6)}`} detail="provider list price" />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Filter by status" className="flex flex-wrap gap-2">
          {FILTERS.map((entry) => (
            <Link
              key={entry.value}
              href={`/admin/support?status=${entry.value}${query ? `&q=${encodeURIComponent(query)}` : ''}`}
              aria-current={status === entry.value ? 'page' : undefined}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                status === entry.value
                  ? 'border-zinc-500 bg-zinc-800 text-zinc-50'
                  : 'border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
              }`}
            >
              {entry.label}
              {entry.value !== 'all' && <span className="ml-1.5 text-xs text-zinc-500">{counts[entry.value]}</span>}
            </Link>
          ))}
        </nav>
        <form className="flex gap-2" action="/admin/support">
          <input type="hidden" name="status" value={status} />
          <input name="q" defaultValue={query} placeholder="#number, subject or email" aria-label="Search requests" className={`${INPUT_CLASS} w-64`} />
        </form>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Subject</Th>
                <Th>Customer</Th>
                <Th>Category</Th>
                <Th>Priority</Th>
                <Th>Status</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.length === 0 ? (
                <EmptyRow colSpan={7} label={status === 'open' ? 'Nothing is waiting on us.' : 'No requests match.'} />
              ) : (
                rows.map((ticket) => (
                  <tr key={ticket.id}>
                    <Td><span className="tabular-nums text-zinc-400">{ticket.number}</span></Td>
                    <Td>
                      <Link href={`/admin/support/${ticket.id}`} className="font-medium text-zinc-100 underline underline-offset-4">
                        {ticket.subject}
                      </Link>
                      <div className="text-xs text-zinc-500">{ticket.messageCount} message{ticket.messageCount === 1 ? '' : 's'}</div>
                    </Td>
                    <Td><span className="break-all text-zinc-300">{ticket.email ?? 'Deleted account'}</span></Td>
                    <Td>{categoryLabel(ticket.category)}</Td>
                    <Td><span className={PRIORITY_TONE[ticket.priority]}>{priorityLabel(ticket.priority)}</span></Td>
                    <Td><Badge value={ticket.status} /></Td>
                    <Td><span className="whitespace-nowrap text-zinc-400">{age(ticket.updatedAt)}</span></Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager basePath="/admin/support" page={page} pageSize={size} total={total} query={{ status, q: query || undefined }} label="requests" />
      </Card>
    </>
  );
}

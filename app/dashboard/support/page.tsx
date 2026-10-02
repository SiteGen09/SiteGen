import Link from 'next/link';

import { requireUser } from '@/lib/dashboard/session';
import { SUPPORT_EMAIL } from '@/lib/site-config';
import { currentSession, loadSession } from '@/lib/support/assistant';
import { listCustomerTickets } from '@/lib/support/tickets';
import { categoryLabel, customerStatusLabel, type SupportChatTurn } from '@/lib/support/types';
import { PageHeader } from '../ui';
import { SupportAssistant } from './assistant';
import { ContactSupportButton, SupportProvider } from './contact-support';

export const metadata = { title: 'Support - sitegen' };

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-amber-50 text-amber-700',
  answered: 'bg-emerald-50 text-emerald-700',
  closed: 'bg-zinc-100 text-zinc-600',
};

export default async function SupportPage() {
  const user = await requireUser();
  const [sessionId, tickets] = await Promise.all([currentSession(user.id), listCustomerTickets(user.id)]);
  const turns: SupportChatTurn[] = sessionId === null ? [] : await loadSession(user.id, sessionId);
  const unread = tickets.filter((ticket) => ticket.customerUnread).length;

  return (
    <SupportProvider>
      <div className="flex flex-wrap items-start justify-between gap-x-4">
        <PageHeader title="Support" description="Get instant setup help from the assistant, or send a request to our team." />
        <ContactSupportButton />
      </div>

      {unread > 0 && (
        <p role="status" className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Support replied to {unread === 1 ? 'one of your requests' : `${unread} of your requests`}. Open it below to read the reply.
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <SupportAssistant initialSessionId={sessionId} initialTurns={turns} />

        <section aria-labelledby="requests-heading" className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="requests-heading" className="text-sm font-semibold text-zinc-900">Your requests</h2>
            <span className="text-xs text-zinc-500">{tickets.length === 0 ? '' : `${tickets.length} total`}</span>
          </div>

          {tickets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-4 py-8 text-center">
              <p className="text-sm text-zinc-700">No requests yet.</p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                Found a bug, have a billing question, or need a person? Press Contact support.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
              {tickets.map((ticket) => (
                <li key={ticket.id}>
                  <Link
                    href={`/dashboard/support/${ticket.id}`}
                    className="block px-4 py-3 transition hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-700"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className={`min-w-0 truncate text-sm ${ticket.customerUnread ? 'font-semibold text-zinc-950' : 'font-medium text-zinc-800'}`}>
                        {ticket.customerUnread && <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-600 align-middle" aria-label="New reply" />}
                        {ticket.subject}
                      </p>
                      <span className="shrink-0 text-xs tabular-nums text-zinc-400">#{ticket.number}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <span className={`rounded px-1.5 py-0.5 font-medium ${STATUS_STYLE[ticket.status] ?? ''}`}>
                        {customerStatusLabel(ticket.status)}
                      </span>
                      <span>{categoryLabel(ticket.category)}</span>
                      <span aria-hidden="true">·</span>
                      <span>Updated {DATE.format(ticket.updatedAt)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-4 text-xs leading-5 text-zinc-500">
            Guides: <Link href="/setup" className="underline">Setup</Link> ·{' '}
            <Link href="/docs" className="underline">API docs</Link> ·{' '}
            <Link href="/dashboard/status" className="underline">Model status</Link>. Or email{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">{SUPPORT_EMAIL}</a>.
          </p>
        </section>
      </div>
    </SupportProvider>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireUser } from '@/lib/dashboard/session';
import { loadTicket, markReadByCustomer } from '@/lib/support/tickets';
import { categoryLabel, customerStatusLabel, priorityLabel } from '@/lib/support/types';
import { formatTimestamp } from '../../ui';
import { closeTicketAction } from '../actions';
import { RichText } from '../rich-text';
import { ReplyForm } from './reply-form';

export const metadata = { title: 'Support request - sitegen' };

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function SupportTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const user = await requireUser();
  const [{ id }, { created }] = await Promise.all([params, searchParams]);
  const ticket = await loadTicket(id, user.id);
  if (ticket === null) notFound();
  if (ticket.customerUnread) await markReadByCustomer(user.id, ticket.id);

  return (
    <div className="max-w-3xl">
      <Link href="/dashboard/support" className="text-sm text-zinc-600 underline hover:text-zinc-900">
        ← Support
      </Link>

      {created === '1' && (
        <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Request #{ticket.number} sent. We will reply here; replies show on the Support page and your dashboard overview.
        </p>
      )}

      <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold text-zinc-900">{ticket.subject}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            #{ticket.number} · {categoryLabel(ticket.category)} · {priorityLabel(ticket.priority)} priority ·{' '}
            <span className="font-medium text-zinc-700">{customerStatusLabel(ticket.status)}</span>
          </p>
        </div>
        {ticket.status !== 'closed' && (
          <form action={closeTicketAction}>
            <input type="hidden" name="id" value={ticket.id} />
            <button
              type="submit"
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
            >
              Mark as resolved
            </button>
          </form>
        )}
      </header>

      {(ticket.requestId || ticket.orderId) && (
        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
          {ticket.requestId && (
            <div>
              <dt className="inline">Request ID: </dt>
              <dd className="inline font-mono text-zinc-700">{ticket.requestId}</dd>
            </div>
          )}
          {ticket.orderId && (
            <div>
              <dt className="inline">Payment/order ID: </dt>
              <dd className="inline font-mono text-zinc-700">{ticket.orderId}</dd>
            </div>
          )}
        </dl>
      )}

      <ol className="mt-6 space-y-4">
        {ticket.messages.map((message) => {
          const staff = message.authorRole === 'staff';
          return (
            <li
              key={message.id}
              className={`rounded-xl border px-4 py-3 ${staff ? 'border-emerald-200 bg-emerald-50/60' : 'border-zinc-200 bg-white'}`}
            >
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <span className={`text-sm font-semibold ${staff ? 'text-emerald-800' : 'text-zinc-900'}`}>
                  {staff ? 'sitegen support' : 'You'}
                </span>
                <time className="text-xs text-zinc-500" dateTime={message.createdAt.toISOString()}>
                  {formatTimestamp(message.createdAt.toISOString())}
                </time>
              </div>
              <div className="text-zinc-800">
                <RichText text={message.body} />
              </div>
              {message.attachments.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {message.attachments.map((file) => (
                    <li key={file.id}>
                      <a
                        href={`/api/support/attachments/${file.id}`}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex max-w-64 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                      >
                        <span className="truncate">{file.filename}</span>
                        <span className="shrink-0 text-zinc-400">{size(file.sizeBytes)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-6">
        <ReplyForm ticketId={ticket.id} closed={ticket.status === 'closed'} />
      </div>
    </div>
  );
}

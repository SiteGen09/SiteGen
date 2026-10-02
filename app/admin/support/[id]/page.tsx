import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireAdmin } from '@/lib/api/admin';
import { loadLinkedChat, loadTicket } from '@/lib/support/tickets';
import { categoryLabel, priorityLabel } from '@/lib/support/types';
import { Badge, Card, PageTitle } from '../../_components/ui';
import { BUTTON_SUBTLE_CLASS } from '../../_components/action-state';
import { changeTicketStatus } from '../actions';
import { StaffReplyForm } from './staff-reply-form';

export const dynamic = 'force-dynamic';

function when(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function SupportTicketAdminPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const ticket = await loadTicket(id);
  if (ticket === null) notFound();
  const chat = ticket.chatSessionId ? await loadLinkedChat(ticket.userId, ticket.chatSessionId) : [];

  return (
    <>
      <Link href="/admin/support" className="mb-4 inline-block text-sm text-zinc-400 underline">← Support requests</Link>
      <PageTitle
        title={`#${ticket.number} ${ticket.subject}`}
        subtitle={`${categoryLabel(ticket.category)} · ${priorityLabel(ticket.priority)} priority · opened ${when(ticket.createdAt)}`}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {ticket.messages.map((message) => {
            const staff = message.authorRole === 'staff';
            return (
              <section
                key={message.id}
                className={`rounded-lg border p-4 ${staff ? 'border-emerald-900 bg-emerald-950/40' : 'border-zinc-800 bg-zinc-900'}`}
              >
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className={`font-medium ${staff ? 'text-emerald-300' : 'text-zinc-200'}`}>
                    {staff ? `Staff${message.authorEmail ? ` (${message.authorEmail})` : ''}` : 'Customer'}
                  </span>
                  <span className="text-zinc-500">{when(message.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-zinc-100">{message.body}</p>
                {message.attachments.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {message.attachments.map((file) => (
                      <li key={file.id}>
                        <a
                          href={`/api/support/attachments/${file.id}`}
                          target="_blank"
                          rel="noopener"
                          className="inline-flex max-w-64 items-center gap-2 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          <span className="truncate">{file.filename}</span>
                          <span className="shrink-0 text-zinc-500">{file.mediaType} · {size(file.sizeBytes)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}

          <Card title="Reply">
            <StaffReplyForm id={ticket.id} />
          </Card>

          {chat.length > 0 && (
            <Card title="Setup assistant conversation before this request">
              <ol className="space-y-3 text-sm">
                {chat.map((turn, index) => (
                  <li key={index}>
                    <div className="text-xs text-zinc-500">
                      {turn.role === 'user' ? 'Customer' : `Assistant${turn.model ? ` (${turn.model})` : ''}`} · {when(turn.createdAt)}
                    </div>
                    <p className={`whitespace-pre-wrap break-words ${turn.role === 'user' ? 'text-zinc-100' : 'text-zinc-400'}`}>
                      {turn.content}
                    </p>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>

        <aside className="space-y-4">
          <Card title="Status">
            <div className="mb-3"><Badge value={ticket.status} /></div>
            <form action={changeTicketStatus} className="flex flex-wrap gap-2">
              <input type="hidden" name="id" value={ticket.id} />
              {ticket.status !== 'closed' && (
                <button name="status" value="closed" className={BUTTON_SUBTLE_CLASS}>Close</button>
              )}
              {ticket.status !== 'open' && (
                <button name="status" value="open" className={BUTTON_SUBTLE_CLASS}>Reopen</button>
              )}
            </form>
          </Card>

          <Card title="Customer">
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs text-zinc-500">Email</dt>
                <dd className="break-all">
                  {ticket.email ? <a className="underline" href={`mailto:${ticket.email}?subject=${encodeURIComponent(`Re: [#${ticket.number}] ${ticket.subject}`)}`}>{ticket.email}</a> : 'Deleted account'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">User</dt>
                <dd><Link className="font-mono text-xs underline" href={`/admin/users/${ticket.userId}`}>{ticket.userId}</Link></dd>
              </div>
              {ticket.requestId && (
                <div>
                  <dt className="text-xs text-zinc-500">Request ID</dt>
                  <dd className="break-all font-mono text-xs">{ticket.requestId}</dd>
                </div>
              )}
              {ticket.orderId && (
                <div>
                  <dt className="text-xs text-zinc-500">Payment/order ID</dt>
                  <dd className="break-all font-mono text-xs">
                    <Link className="underline" href={`/admin/orders?q=${encodeURIComponent(ticket.orderId)}`}>{ticket.orderId}</Link>
                  </dd>
                </div>
              )}
            </dl>
          </Card>

          <Card title="Diagnostics">
            {ticket.diagnostics ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs leading-5 text-zinc-300">
                {JSON.stringify(ticket.diagnostics, null, 2)}
              </pre>
            ) : (
              <p className="text-sm text-zinc-500">The customer chose not to attach diagnostics.</p>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}

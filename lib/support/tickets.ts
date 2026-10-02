import { z } from 'zod';

import { ApiError } from '@/lib/api/errors';
import { writeAudit } from '@/lib/api/admin';
import { loadPlan } from '@/lib/chat/pipeline';
import { sql } from '@/lib/db';
import { accountSnapshot } from './assistant';
import type { CheckedAttachment } from './attachments';
import {
  BODY_MAX,
  CATEGORY_VALUES,
  PRIORITY_VALUES,
  SUBJECT_MAX,
  type TicketStatus,
} from './types';

/**
 * Support requests: a ticket, its thread of customer and staff messages, and
 * their attachments. Server-only. Every function takes the acting user id and
 * scopes by it; the routes and actions establish that id from the session.
 */

const NEW_TICKETS_PER_HOUR = 5;
const MESSAGES_PER_HOUR = 30;

const optionalRef = z
  .string()
  .trim()
  .max(128)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .default(null);

export const newTicketSchema = z.object({
  subject: z.string().trim().min(3, 'Enter a subject of at least 3 characters.').max(SUBJECT_MAX),
  category: z.enum(CATEGORY_VALUES),
  priority: z.enum(PRIORITY_VALUES).default('normal'),
  body: z.string().trim().min(10, 'Describe the problem in at least 10 characters.').max(BODY_MAX),
  requestId: optionalRef,
  orderId: optionalRef,
  chatSessionId: z.uuid().nullable().default(null),
  /** What the browser reported, only when the customer left the box ticked. */
  clientDiagnostics: z
    .object({
      userAgent: z.string().max(400).optional(),
      page: z.string().max(400).optional(),
      timezone: z.string().max(80).optional(),
      language: z.string().max(40).optional(),
      screen: z.string().max(40).optional(),
    })
    .nullable()
    .default(null),
});
export type NewTicketInput = z.infer<typeof newTicketSchema>;

export const replySchema = z.object({
  body: z.string().trim().min(1, 'Enter a message.').max(BODY_MAX),
});

async function enforceTicketLimits(userId: string, creating: boolean): Promise<void> {
  const [row] = await sql<{ tickets: number; messages: number }[]>`
    SELECT
      (SELECT count(*)::int FROM support_tickets
        WHERE user_id = ${userId} AND created_at > now() - interval '1 hour') AS tickets,
      (SELECT count(*)::int FROM support_ticket_messages m JOIN support_tickets t ON t.id = m.ticket_id
        WHERE t.user_id = ${userId} AND m.author_role = 'customer'
          AND m.created_at > now() - interval '1 hour') AS messages`;
  if (creating && (row?.tickets ?? 0) >= NEW_TICKETS_PER_HOUR) {
    throw new ApiError('rate_limited', 'You have opened several requests in the last hour. Add to an existing request, or try again later.', 429);
  }
  if ((row?.messages ?? 0) >= MESSAGES_PER_HOUR) {
    throw new ApiError('rate_limited', 'You have sent many messages in the last hour. Please try again later.', 429);
  }
}

async function diagnosticsFor(userId: string, client: NewTicketInput['clientDiagnostics']): Promise<Record<string, unknown>> {
  const [plan, snapshot] = await Promise.all([
    loadPlan(userId).then((value) => value.key).catch(() => 'unknown'),
    accountSnapshot(userId),
  ]);
  return { collectedAt: new Date().toISOString(), plan, ...snapshot, client };
}

export async function createTicket(
  userId: string,
  input: NewTicketInput,
  attachments: readonly CheckedAttachment[],
  attachDiagnostics: boolean,
): Promise<{ id: string; number: number }> {
  await enforceTicketLimits(userId, true);
  const diagnostics = attachDiagnostics ? await diagnosticsFor(userId, input.clientDiagnostics) : null;

  // A linked assistant conversation must be the customer's own.
  let chatSessionId = input.chatSessionId;
  if (chatSessionId !== null) {
    const [owned] = await sql`
      SELECT 1 FROM support_chat_messages WHERE user_id = ${userId} AND session_id = ${chatSessionId} LIMIT 1`;
    if (!owned) chatSessionId = null;
  }

  return await sql.begin(async (tx) => {
    const [ticket] = await tx<{ id: string; number: string }[]>`
      INSERT INTO support_tickets
        (user_id, subject, category, priority, request_id, order_id, diagnostics, chat_session_id)
      VALUES (${userId}, ${input.subject}, ${input.category}, ${input.priority}, ${input.requestId},
        ${input.orderId}, ${diagnostics === null ? null : tx.json(diagnostics as Parameters<typeof tx.json>[0])}, ${chatSessionId})
      RETURNING id, number::text`;
    const [message] = await tx<{ id: string }[]>`
      INSERT INTO support_ticket_messages (ticket_id, author_id, author_role, body)
      VALUES (${ticket!.id}, ${userId}, 'customer', ${input.body})
      RETURNING id`;
    for (const file of attachments) {
      await tx`
        INSERT INTO support_attachments (ticket_id, message_id, filename, media_type, size_bytes, data)
        VALUES (${ticket!.id}, ${message!.id}, ${file.filename}, ${file.mediaType}, ${file.data.length}, ${file.data})`;
    }
    return { id: ticket!.id, number: Number(ticket!.number) };
  });
}

/** A customer reply reopens the ticket: it is waiting on staff again. */
export async function addCustomerMessage(
  userId: string,
  ticketId: string,
  body: string,
  attachments: readonly CheckedAttachment[],
): Promise<void> {
  await enforceTicketLimits(userId, false);
  await sql.begin(async (tx) => {
    const [ticket] = await tx`
      UPDATE support_tickets
      SET status = 'open', closed_at = NULL, updated_at = now()
      WHERE id = ${ticketId} AND user_id = ${userId}
      RETURNING id`;
    if (!ticket) throw new ApiError('not_found', 'That request no longer exists.', 404);
    const [message] = await tx<{ id: string }[]>`
      INSERT INTO support_ticket_messages (ticket_id, author_id, author_role, body)
      VALUES (${ticketId}, ${userId}, 'customer', ${body})
      RETURNING id`;
    for (const file of attachments) {
      await tx`
        INSERT INTO support_attachments (ticket_id, message_id, filename, media_type, size_bytes, data)
        VALUES (${ticketId}, ${message!.id}, ${file.filename}, ${file.mediaType}, ${file.data.length}, ${file.data})`;
    }
  });
}

export async function closeTicketAsCustomer(userId: string, ticketId: string): Promise<void> {
  await sql`
    UPDATE support_tickets SET status = 'closed', closed_at = now(), updated_at = now()
    WHERE id = ${ticketId} AND user_id = ${userId} AND status <> 'closed'`;
}

export interface TicketSummary {
  id: string;
  number: number;
  subject: string;
  category: string;
  priority: string;
  status: TicketStatus;
  customerUnread: boolean;
  createdAt: Date;
  updatedAt: Date;
  email?: string | null;
  messageCount: number;
}

type SummaryRow = {
  id: string;
  number: string;
  subject: string;
  category: string;
  priority: string;
  status: TicketStatus;
  customer_unread: boolean;
  created_at: Date;
  updated_at: Date;
  email?: string | null;
  message_count: number;
};

function toSummary(row: SummaryRow): TicketSummary {
  return {
    id: row.id,
    number: Number(row.number),
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    customerUnread: row.customer_unread,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    email: row.email,
    messageCount: row.message_count,
  };
}

export async function listCustomerTickets(userId: string): Promise<TicketSummary[]> {
  const rows = await sql<SummaryRow[]>`
    SELECT t.id, t.number::text, t.subject, t.category, t.priority, t.status, t.customer_unread,
      t.created_at, t.updated_at,
      (SELECT count(*)::int FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS message_count
    FROM support_tickets t
    WHERE t.user_id = ${userId}
    ORDER BY t.updated_at DESC
    LIMIT 100`;
  return rows.map(toSummary);
}

/** Tickets with a staff reply the customer has not opened. */
export async function unreadTicketCount(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM support_tickets WHERE user_id = ${userId} AND customer_unread`;
  return row?.count ?? 0;
}

export async function listQueue(
  filter: { status: TicketStatus | 'all'; query: string },
  limit: number,
  offset: number,
): Promise<{ rows: TicketSummary[]; total: number }> {
  const status = filter.status === 'all' ? null : filter.status;
  const query = filter.query.trim();
  const numeric = /^#?\d+$/.test(query) ? Number(query.replace('#', '')) : null;
  const like = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const where = sql`
    WHERE (${status}::text IS NULL OR t.status = ${status})
      AND (${query} = '' OR t.number = ${numeric} OR t.subject ILIKE ${like} OR p.email ILIKE ${like})`;
  const [rows, [count]] = await Promise.all([
    sql<SummaryRow[]>`
      SELECT t.id, t.number::text, t.subject, t.category, t.priority, t.status, t.customer_unread,
        t.created_at, t.updated_at, p.email,
        (SELECT count(*)::int FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS message_count
      FROM support_tickets t LEFT JOIN profiles p ON p.id = t.user_id
      ${where}
      ORDER BY (t.status = 'open') DESC,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        t.updated_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    sql<{ total: number }[]>`
      SELECT count(*)::int AS total FROM support_tickets t LEFT JOIN profiles p ON p.id = t.user_id ${where}`,
  ]);
  return { rows: rows.map(toSummary), total: count?.total ?? 0 };
}

export async function queueCounts(): Promise<Record<TicketStatus, number>> {
  const rows = await sql<{ status: TicketStatus; count: number }[]>`
    SELECT status, count(*)::int AS count FROM support_tickets GROUP BY status`;
  const counts: Record<TicketStatus, number> = { open: 0, answered: 0, closed: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

export interface TicketMessage {
  id: string;
  authorRole: 'customer' | 'staff';
  authorEmail: string | null;
  body: string;
  createdAt: Date;
  attachments: { id: string; filename: string; mediaType: string; sizeBytes: number }[];
}

export interface TicketDetail extends TicketSummary {
  userId: string;
  requestId: string | null;
  orderId: string | null;
  diagnostics: unknown;
  chatSessionId: string | null;
  closedAt: Date | null;
  messages: TicketMessage[];
}

/** `userId` scopes the read to one customer; omit it only for staff. */
export async function loadTicket(ticketId: string, userId?: string): Promise<TicketDetail | null> {
  if (!z.uuid().safeParse(ticketId).success) return null;
  const [ticket] = await sql<(SummaryRow & {
    user_id: string;
    request_id: string | null;
    order_id: string | null;
    diagnostics: unknown;
    chat_session_id: string | null;
    closed_at: Date | null;
  })[]>`
    SELECT t.id, t.number::text AS number, t.user_id, t.subject, t.category, t.priority, t.status,
      t.customer_unread, t.request_id, t.order_id, t.diagnostics, t.chat_session_id,
      t.created_at, t.updated_at, t.closed_at, p.email, 0 AS message_count
    FROM support_tickets t LEFT JOIN profiles p ON p.id = t.user_id
    WHERE t.id = ${ticketId} AND (${userId ?? null}::uuid IS NULL OR t.user_id = ${userId ?? null})`;
  if (!ticket) return null;

  const [messages, attachments] = await Promise.all([
    sql<{ id: string; author_role: 'customer' | 'staff'; email: string | null; body: string; created_at: Date }[]>`
      SELECT m.id, m.author_role, p.email, m.body, m.created_at
      FROM support_ticket_messages m LEFT JOIN profiles p ON p.id = m.author_id
      WHERE m.ticket_id = ${ticketId}
      ORDER BY m.created_at, m.id`,
    sql<{ id: string; message_id: string; filename: string; media_type: string; size_bytes: number }[]>`
      SELECT id, message_id, filename, media_type, size_bytes
      FROM support_attachments WHERE ticket_id = ${ticketId}
      ORDER BY created_at, id`,
  ]);

  return {
    ...toSummary({ ...ticket, message_count: messages.length }),
    userId: ticket.user_id,
    requestId: ticket.request_id,
    orderId: ticket.order_id,
    diagnostics: ticket.diagnostics,
    chatSessionId: ticket.chat_session_id,
    closedAt: ticket.closed_at,
    messages: messages.map((message) => ({
      id: message.id,
      authorRole: message.author_role,
      authorEmail: message.email,
      body: message.body,
      createdAt: message.created_at,
      attachments: attachments
        .filter((file) => file.message_id === message.id)
        .map((file) => ({ id: file.id, filename: file.filename, mediaType: file.media_type, sizeBytes: file.size_bytes })),
    })),
  };
}

export async function markReadByCustomer(userId: string, ticketId: string): Promise<void> {
  await sql`
    UPDATE support_tickets SET customer_unread = false
    WHERE id = ${ticketId} AND user_id = ${userId} AND customer_unread`;
  // Reading the thread answers the reply notifications that pointed at it.
  await sql`
    INSERT INTO notification_reads (user_id, notification_id)
    SELECT ${userId}, id FROM notifications
    WHERE user_id = ${userId} AND kind = 'support_reply' AND link = ${`/dashboard/support/${ticketId}`}
    ON CONFLICT DO NOTHING`;
}

/**
 * A staff reply marks the ticket answered, flags it unread for the customer,
 * and leaves them a notification pointing at the thread.
 */
export async function addStaffReply(
  adminId: string,
  ticketId: string,
  body: string,
  status: TicketStatus,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [before] = await tx<{ status: string; user_id: string; number: string; subject: string }[]>`
      SELECT status, user_id, number::text AS number, subject FROM support_tickets WHERE id = ${ticketId} FOR UPDATE`;
    if (!before) throw new ApiError('not_found', 'no such ticket', 404);
    await tx`
      INSERT INTO notifications (kind, user_id, title, body, link)
      VALUES ('support_reply', ${before.user_id}, ${`Support replied to request #${before.number}`.slice(0, 200)},
        ${`New reply on "${before.subject}".`.slice(0, 5000)}, ${`/dashboard/support/${ticketId}`})`;
    await tx`
      INSERT INTO support_ticket_messages (ticket_id, author_id, author_role, body)
      VALUES (${ticketId}, ${adminId}, 'staff', ${body})`;
    await tx`
      UPDATE support_tickets
      SET status = ${status}, customer_unread = true, updated_at = now(),
        closed_at = CASE WHEN ${status} = 'closed' THEN now() ELSE NULL END
      WHERE id = ${ticketId}`;
    await writeAudit(adminId, 'support.reply', `support_ticket:${ticketId}`, { status: before.status }, { status }, tx);
  });
}

export async function setTicketStatus(adminId: string, ticketId: string, status: TicketStatus): Promise<void> {
  await sql.begin(async (tx) => {
    const [before] = await tx<{ status: string }[]>`
      SELECT status FROM support_tickets WHERE id = ${ticketId} FOR UPDATE`;
    if (!before) throw new ApiError('not_found', 'no such ticket', 404);
    await tx`
      UPDATE support_tickets
      SET status = ${status}, updated_at = now(),
        closed_at = CASE WHEN ${status} = 'closed' THEN now() ELSE NULL END
      WHERE id = ${ticketId}`;
    await writeAudit(adminId, 'support.status', `support_ticket:${ticketId}`, { status: before.status }, { status }, tx);
  });
}

/** An attachment with the ticket owner, so the caller can check access. */
export async function loadAttachment(
  id: string,
): Promise<{ ownerId: string; filename: string; mediaType: string; data: Buffer } | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await sql<{ user_id: string; filename: string; media_type: string; data: Buffer }[]>`
    SELECT t.user_id, a.filename, a.media_type, a.data
    FROM support_attachments a JOIN support_tickets t ON t.id = a.ticket_id
    WHERE a.id = ${id}`;
  return row ? { ownerId: row.user_id, filename: row.filename, mediaType: row.media_type, data: row.data } : null;
}

/** The assistant conversation a ticket escalated from, for staff. */
export async function loadLinkedChat(
  userId: string,
  sessionId: string,
): Promise<{ role: string; content: string; model: string | null; createdAt: Date }[]> {
  const rows = await sql<{ role: string; content: string; model: string | null; created_at: Date }[]>`
    SELECT role, content, model, created_at FROM support_chat_messages
    WHERE user_id = ${userId} AND session_id = ${sessionId}
    ORDER BY created_at, id LIMIT 200`;
  return rows.map((row) => ({ role: row.role, content: row.content, model: row.model, createdAt: row.created_at }));
}

/** Assistant spend, for the admin queue header. */
export async function assistantSpend(days: number): Promise<{ answers: number; costUsd: number; users: number }> {
  const [row] = await sql<{ answers: number; cost: string | null; users: number }[]>`
    SELECT count(*)::int AS answers, sum(cost_usd)::text AS cost, count(DISTINCT user_id)::int AS users
    FROM support_chat_messages
    WHERE role = 'assistant' AND created_at > now() - make_interval(days => ${days})`;
  return { answers: row?.answers ?? 0, costUsd: Number(row?.cost ?? 0), users: row?.users ?? 0 };
}

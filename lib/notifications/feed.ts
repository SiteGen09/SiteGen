import { planMeetsMinimum } from '@/lib/billing/plans';
import { sql } from '@/lib/db';

import type { NotificationKind } from './types';

/**
 * A user's notification feed. Server-only; every function is scoped by the
 * user id the caller took from the session.
 *
 * A broadcast (user_id NULL) reaches every user on its minimum plan or above.
 * It is unread while it is newer than the user's "mark all read" watermark
 * (their signup when they have none) and has no read receipt. The feed skips
 * broadcasts from well before the user joined: a new user's first visit should
 * not open on months of model news.
 */

const HISTORY_BEFORE_SIGNUP = '7 days';
const FEED_LIMIT = 50;

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  important: boolean;
  createdAt: Date;
  read: boolean;
}

interface Row {
  id: string;
  kind: NotificationKind;
  user_id: string | null;
  min_plan: string;
  title: string;
  body: string;
  link: string | null;
  important: boolean;
  created_at: Date;
  read: boolean;
  plan: string;
}

async function visible(userId: string, options: { unreadOnly: boolean; limit: number }): Promise<Row[]> {
  const rows = await sql<Row[]>`
    WITH me AS (
      SELECT p.id, COALESCE(s.seen_before, p.created_at) AS seen_before, p.created_at AS joined,
        COALESCE(e.plan_key, 'free') AS plan
      FROM profiles p
      LEFT JOIN notification_user_state s ON s.user_id = p.id
      LEFT JOIN entitlements e ON e.user_id = p.id
      WHERE p.id = ${userId}
    )
    SELECT n.id::text, n.kind, n.user_id, n.min_plan, n.title, n.body, n.link, n.important, n.created_at,
      (r.user_id IS NOT NULL OR n.created_at <= me.seen_before) AS read, me.plan
    FROM me
    JOIN notifications n ON (n.user_id = me.id OR (n.user_id IS NULL AND n.created_at > me.joined - ${HISTORY_BEFORE_SIGNUP}::interval))
    LEFT JOIN notification_reads r ON r.user_id = me.id AND r.notification_id = n.id
    WHERE (n.expires_at IS NULL OR n.expires_at > now())
      AND (NOT ${options.unreadOnly} OR (r.user_id IS NULL AND n.created_at > me.seen_before))
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ${options.limit * 2}`;
  // Plan ranks live in application config, so the plan filter runs here. The
  // doubled limit leaves room for rows a lower plan cannot see.
  return rows.filter((row) => row.user_id !== null || planMeetsMinimum(row.plan, row.min_plan)).slice(0, options.limit);
}

function toItem(row: Row): NotificationItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    important: row.important,
    createdAt: row.created_at,
    read: row.read,
  };
}

export async function listNotifications(userId: string): Promise<NotificationItem[]> {
  return (await visible(userId, { unreadOnly: false, limit: FEED_LIMIT })).map(toItem);
}

/** Unread count for the nav badge, and the newest unread important notice for the banner. */
export async function notificationSummary(userId: string): Promise<{ unread: number; banner: NotificationItem | null }> {
  const unread = await visible(userId, { unreadOnly: true, limit: 100 });
  const banner = unread.find((row) => row.important);
  return { unread: unread.length, banner: banner ? toItem(banner) : null };
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await sql`
    INSERT INTO notification_user_state (user_id, seen_before) VALUES (${userId}, now())
    ON CONFLICT (user_id) DO UPDATE SET seen_before = now()`;
}

/** Marks one notification read, only if this user can see it. */
export async function markNotificationRead(userId: string, notificationId: string): Promise<void> {
  await sql`
    INSERT INTO notification_reads (user_id, notification_id)
    SELECT ${userId}, n.id FROM notifications n
    WHERE n.id = ${notificationId} AND (n.user_id IS NULL OR n.user_id = ${userId})
    ON CONFLICT DO NOTHING`;
}

import { requireAdmin } from '@/lib/api/admin';
import { getPlans, PLAN_KEYS } from '@/lib/billing/plans';
import { sql } from '@/lib/db';
import { NOTIFICATION_KIND_LABELS, type NotificationKind } from '@/lib/notifications/types';
import { Card, EmptyRow, PageTitle, Td, Th } from '../_components/ui';
import { deleteNotificationAction } from './actions';
import { AnnouncementForm } from './announcement-form';

export const dynamic = 'force-dynamic';

export default async function AdminNotificationsPage() {
  await requireAdmin();
  const plans = getPlans();
  const [broadcasts, personal] = await Promise.all([
    sql<{ id: string; kind: NotificationKind; title: string; body: string; min_plan: string; important: boolean; created_at: Date; expires_at: Date | null; reads: number }[]>`
      SELECT n.id::text, n.kind, n.title, n.body, n.min_plan, n.important, n.created_at, n.expires_at,
        (SELECT count(*)::int FROM notification_reads r WHERE r.notification_id = n.id) AS reads
      FROM notifications n WHERE n.user_id IS NULL
      ORDER BY n.created_at DESC LIMIT 50`,
    sql<{ kind: NotificationKind; count: number }[]>`
      SELECT kind, count(*)::int AS count FROM notifications
      WHERE user_id IS NOT NULL AND created_at > now() - interval '7 days'
      GROUP BY kind ORDER BY kind`,
  ]);

  return (
    <>
      <PageTitle
        title="Notifications"
        subtitle="Announcements you send, plus the model and price notices the platform sends on its own every few minutes."
      />
      <Card title="Send an announcement">
        <AnnouncementForm plans={PLAN_KEYS.map((key) => ({ key, label: plans[key].label }))} />
      </Card>
      <Card title="Sent to users">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead><tr><Th>Sent</Th><Th>Type</Th><Th>Notice</Th><Th>Audience</Th><Th>Dismissed by</Th><Th>Expires</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody className="divide-y divide-zinc-800">
              {broadcasts.length === 0 ? <EmptyRow colSpan={7} label="Nothing sent yet." /> : broadcasts.map((row) => (
                <tr key={row.id}>
                  <Td>{row.created_at.toISOString().slice(0, 16).replace('T', ' ')}</Td>
                  <Td>{NOTIFICATION_KIND_LABELS[row.kind]}{row.important ? ' · important' : ''}</Td>
                  <Td>
                    <p className="font-medium text-zinc-100">{row.title}</p>
                    <p className="mt-1 line-clamp-3 max-w-xl whitespace-pre-line text-xs text-zinc-400">{row.body}</p>
                  </Td>
                  <Td>{row.min_plan === 'free' ? 'Everyone' : `${plans[row.min_plan as keyof typeof plans]?.label ?? row.min_plan}+`}</Td>
                  <Td>{row.reads.toLocaleString()}</Td>
                  <Td>{row.expires_at ? row.expires_at.toISOString().slice(0, 16).replace('T', ' ') : '—'}</Td>
                  <Td>
                    <form action={deleteNotificationAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <button className="text-red-400 underline">Withdraw</button>
                    </form>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Personal alerts, last 7 days">
        {personal.length === 0 ? (
          <p className="text-sm text-zinc-400">None sent.</p>
        ) : (
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-300">
            {personal.map((row) => (
              <li key={row.kind}>{NOTIFICATION_KIND_LABELS[row.kind]} ({row.kind.replace('_', ' ')}): {row.count}</li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

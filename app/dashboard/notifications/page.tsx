import { requireUser } from '@/lib/dashboard/session';
import { listNotifications } from '@/lib/notifications/feed';
import { PageHeader } from '../ui';
import { MarkSeen } from './mark-seen';
import { NotificationList } from './notification-list';

export const metadata = { title: 'Notifications - sitegen' };

export default async function NotificationsPage() {
  const user = await requireUser();
  const items = await listNotifications(user.id);
  const unread = items.filter((item) => !item.read).length;

  return (
    <>
      <MarkSeen unread={unread} />
      <PageHeader
        title="Notifications"
        description="New and removed models, price changes, announcements, and alerts about your balance, API keys and support requests."
      />

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-4 py-10 text-center">
          <p className="text-sm text-zinc-700">No notifications yet.</p>
          <p className="mt-1 text-xs text-zinc-500">You will see model, pricing and account updates here.</p>
        </div>
      ) : (
        <NotificationList items={items} />
      )}
    </>
  );
}

'use server';

import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/dashboard/session';
import { markAllNotificationsRead, markNotificationRead } from '@/lib/notifications/feed';

/** Opening the notifications page marks everything up to now as read. */
export async function markAllNotificationsReadAction(): Promise<void> {
  const user = await requireUser();
  await markAllNotificationsRead(user.id);
  revalidatePath('/dashboard', 'layout');
}

/** Dismisses one notice, such as the dashboard banner. */
export async function dismissNotificationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = formData.get('id');
  if (typeof id !== 'string' || !/^\d{1,18}$/.test(id)) return;
  await markNotificationRead(user.id, id);
  revalidatePath('/dashboard', 'layout');
}

'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireAdmin, writeAudit } from '@/lib/api/admin';
import { PLAN_KEYS } from '@/lib/billing/plans';
import { sql } from '@/lib/db';
import { BODY_MAX, TITLE_MAX } from '@/lib/notifications/types';
import type { ActionState } from '../_components/action-state';

const announcementSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title.').max(TITLE_MAX, `Keep the title to ${TITLE_MAX} characters.`),
  body: z.string().trim().max(BODY_MAX, `Keep the message to ${BODY_MAX} characters.`),
  link: z.string().trim().max(500).refine((value) => value === '' || /^\/[^/\\]/.test(value), 'Links must be a path on this site, such as /prices.'),
  minPlan: z.enum(PLAN_KEYS),
  important: z.boolean(),
  expiresAt: z.string().trim().max(40),
});

export async function createAnnouncementAction(_state: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = announcementSchema.safeParse({
      title: form.get('title') ?? '',
      body: form.get('body') ?? '',
      link: form.get('link') ?? '',
      minPlan: form.get('minPlan') ?? 'free',
      important: form.get('important') === 'on',
      expiresAt: form.get('expiresAt') ?? '',
    });
    if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the announcement.' };
    const { title, body, link, minPlan, important, expiresAt } = parsed.data;
    const expires = expiresAt ? new Date(`${expiresAt}Z`) : null;
    if (expires && (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now())) {
      return { status: 'error', message: 'The expiry must be a future date and time (UTC).' };
    }
    await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO notifications (kind, min_plan, title, body, link, important, created_by, expires_at)
        VALUES ('announcement', ${minPlan}, ${title}, ${body}, ${link || null}, ${important}, ${ctx.user.id}, ${expires})
        RETURNING id::text`;
      await writeAudit(ctx.user.id, 'notification.announce', `notification:${row!.id}`, null,
        { title, min_plan: minPlan, important, expires_at: expires?.toISOString() ?? null }, tx);
    });
    revalidatePath('/admin/notifications');
    revalidatePath('/dashboard', 'layout');
    return { status: 'success', message: 'Announcement sent. Users see it under Notifications now.' };
  } catch {
    return { status: 'error', message: 'The announcement could not be saved. Reload and try again.' };
  }
}

/** Withdraws a broadcast. Personal notifications are left to their owners. */
export async function deleteNotificationAction(form: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const id = z.string().regex(/^\d{1,18}$/).safeParse(form.get('id'));
  if (!id.success) return;
  await sql.begin(async (tx) => {
    const [before] = await tx`DELETE FROM notifications WHERE id = ${id.data} AND user_id IS NULL
      RETURNING kind, title, created_at`;
    if (before) await writeAudit(ctx.user.id, 'notification.delete', `notification:${id.data}`, before, null, tx);
  });
  revalidatePath('/admin/notifications');
  revalidatePath('/dashboard', 'layout');
}

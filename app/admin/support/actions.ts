'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireAdmin } from '@/lib/api/admin';
import { addStaffReply, setTicketStatus } from '@/lib/support/tickets';
import { BODY_MAX, TICKET_STATUSES } from '@/lib/support/types';
import type { ActionState } from '../_components/action-state';

const replySchema = z.object({
  id: z.uuid(),
  body: z.string().trim().min(1).max(BODY_MAX),
  status: z.enum(TICKET_STATUSES),
});

export async function replyToTicket(_state: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireAdmin();
  const parsed = replySchema.safeParse({ id: form.get('id'), body: form.get('body'), status: form.get('status') });
  if (!parsed.success) return { status: 'error', message: 'Enter a reply of up to 10,000 characters.' };
  try {
    await addStaffReply(ctx.user.id, parsed.data.id, parsed.data.body, parsed.data.status);
  } catch {
    return { status: 'error', message: 'The reply could not be saved. Reload and try again.' };
  }
  revalidatePath('/admin/support');
  revalidatePath(`/admin/support/${parsed.data.id}`);
  return { status: 'success', message: 'Reply sent. The customer sees it under Support and on their overview.' };
}

export async function changeTicketStatus(form: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const parsed = z.object({ id: z.uuid(), status: z.enum(TICKET_STATUSES) })
    .safeParse({ id: form.get('id'), status: form.get('status') });
  if (!parsed.success) return;
  await setTicketStatus(ctx.user.id, parsed.data.id, parsed.data.status);
  revalidatePath('/admin/support');
  revalidatePath(`/admin/support/${parsed.data.id}`);
}

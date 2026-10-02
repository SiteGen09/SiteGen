'use server';

import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/dashboard/session';
import { closeTicketAsCustomer } from '@/lib/support/tickets';

/** The customer marks their own request resolved; a later reply reopens it. */
export async function closeTicketAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = formData.get('id');
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return;
  await closeTicketAsCustomer(user.id, id);
  revalidatePath('/dashboard/support');
  revalidatePath(`/dashboard/support/${id}`);
}

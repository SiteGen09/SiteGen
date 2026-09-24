'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin } from '@/lib/api/admin';
import { releaseDisputeHold } from '@/lib/billing/review';
import type { ActionState } from '../_components/action-state';

export async function reviewDispute(_state: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireAdmin();
  const parsed = z.object({ id:z.uuid(), note:z.string().trim().min(10).max(1000) }).safeParse({id:form.get('id'),note:form.get('note')});
  if (!parsed.success) return {status:'error',message:'Enter a review note of 10–1,000 characters.'};
  try {
    await releaseDisputeHold(ctx.user.id,parsed.data.id,parsed.data.note);
    revalidatePath('/admin/disputes');
    revalidatePath('/dashboard/billing');
    return {status:'success',message:'Review saved. Access resumes only when every dispute is reviewed and there is no manual suspension.'};
  } catch { return {status:'error',message:'Could not release this hold. Confirm the dispute is won or closed and try again.'}; }
}

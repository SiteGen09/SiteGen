'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/dashboard/session';
import { redeemCreditCode } from '@/lib/billing/redemption';

export type RedemptionActionState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'success'; message: string };

export async function redeemCodeAction(
  _previous: RedemptionActionState,
  formData: FormData,
): Promise<RedemptionActionState> {
  try {
    const user = await requireUser();
    const input = formData.get('code');
    const result = await redeemCreditCode(user.id, input);
    revalidatePath('/dashboard/billing');
    if (result.status === 'duplicate') {
      return { status: 'success', message: `This code was already redeemed on your account (${result.credits.toLocaleString()} credits).` };
    }
    return { status: 'success', message: `${result.credits.toLocaleString()} credits added to your balance.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not redeem that code.';
    return { status: 'error', message: ['Enter a valid redemption code.', 'Enter a redemption code.', 'Too many attempts. Try again in a minute.', 'Account access is frozen. Contact support for review.'].includes(message) ? message : 'Invalid or unavailable redemption code.' };
  }
}

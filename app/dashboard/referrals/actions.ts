'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/dashboard/session';
import { transferReferralRewards } from '@/lib/referrals/referrals';

export type TransferState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'success'; message: string };

export async function transferRewardsAction(): Promise<TransferState> {
  try {
    const user = await requireUser();
    const moved = await transferReferralRewards(user.id);
    revalidatePath('/dashboard/referrals');
    revalidatePath('/dashboard/billing');
    return moved > 0
      ? { status: 'success', message: `${moved.toLocaleString('en-US')} credits added to your balance.` }
      : { status: 'error', message: 'No rewards are available to transfer yet.' };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'Could not transfer rewards. Try again.' };
  }
}

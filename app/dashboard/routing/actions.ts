'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { FAMILIES, listSources } from '@/lib/ai/sources';
import { planMeetsMinimum } from '@/lib/billing/plans';
import { loadPlan } from '@/lib/chat/pipeline';
import { requireUser } from '@/lib/dashboard/session';
import { createClient } from '@/lib/supabase/server';

export async function saveRoutingAction(_previous: string, formData: FormData): Promise<string> {
  const user = await requireUser();
  const parsed = z
    .object({ family: z.enum(FAMILIES), sourceId: z.string().min(1) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return 'Choose a source.';
  const [sources, plan] = await Promise.all([listSources(), loadPlan(user.id)]);
  const source = sources.find(
    (s) => s.id === parsed.data.sourceId && s.family === parsed.data.family,
  );
  if (!source || source.status === 'off' || !planMeetsMinimum(plan.key, source.min_plan))
    return 'This source is unavailable on your plan.';
  // Use the session client for this mutation so RLS also checks family and plan
  // at write time. A source changed after validation cannot bypass those checks.
  const supabase = await createClient();
  const { error } = await supabase.from('user_routing_preferences').upsert(
    {
      user_id: user.id,
      family: source.family,
      source_id: source.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,family' },
  );
  if (error) return 'Could not save this source. Refresh and try again.';
  revalidatePath('/dashboard/routing');
  revalidatePath('/dashboard/chat');
  return 'Routing preference saved.';
}

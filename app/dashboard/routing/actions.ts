'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { FAMILIES, MODALITIES, listSources } from '@/lib/ai/sources';
import { loadRoutingProviderNames } from '@/lib/ai/routing-provider-names';
import { planMeetsMinimum } from '@/lib/billing/plans';
import { loadPlan } from '@/lib/chat/pipeline';
import { publicRoutingSourceId, selectableRoutingProviders } from '@/lib/ai/routing-provider';
import { requireUser } from '@/lib/dashboard/session';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function saveRoutingAction(_previous: string, formData: FormData): Promise<string> {
  const user = await requireUser();
  const parsed = z
    .object({
      family: z.enum(FAMILIES),
      modality: z.enum(MODALITIES),
      // Empty means automatic routing: remove the saved preference so the
      // dispatcher can use the default, then any other eligible route.
      sourceId: z.string(),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return 'Choose a source or automatic routing.';
  if (parsed.data.sourceId === '') {
    const service = createServiceClient();
    const { error } = await service
      .from('user_routing_preferences')
      .delete()
      .eq('user_id', user.id)
      .eq('family', parsed.data.family)
      .eq('modality', parsed.data.modality);
    if (error) return 'Could not enable automatic routing. Refresh and try again.';
    revalidatePath('/dashboard/routing');
    revalidatePath('/dashboard/chat');
    return 'Automatic routing enabled.';
  }
  const [sources, plan] = await Promise.all([listSources(), loadPlan(user.id)]);
  // Both halves of the key are checked: a source is only a valid answer for
  // the family AND modality it actually serves.
  const source = sources.find(
    (s) =>
      (s.id === parsed.data.sourceId || publicRoutingSourceId(s.id) === parsed.data.sourceId) &&
      s.family === parsed.data.family &&
      s.modality === parsed.data.modality,
  );
  if (!source || source.status === 'off' || !planMeetsMinimum(plan.key, source.min_plan))
    return 'This source is unavailable on your plan.';
  // Use the session client for this mutation so RLS also checks family,
  // modality and plan at write time. A source changed after validation cannot
  // bypass those checks.
  const supabase = await createClient();
  const { error } = await supabase.from('user_routing_preferences').upsert(
    {
      user_id: user.id,
      family: source.family,
      modality: source.modality,
      source_id: source.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,family,modality' },
  );
  if (error) return 'Could not save this source. Refresh and try again.';
  revalidatePath('/dashboard/routing');
  revalidatePath('/dashboard/chat');
  return 'Routing preference saved.';
}

/**
 * Saves the provider Auto starts on for this user, across every family and
 * modality. Empty follows the platform default. A family-level choice above
 * still wins, and eligibility is unchanged: this only reorders routes.
 */
export async function saveDefaultProviderAction(_previous: string, formData: FormData): Promise<string> {
  const user = await requireUser();
  const requested = z.string().max(255).safeParse(formData.get('providerId') ?? '');
  if (!requested.success) return 'Choose a provider or Auto.';
  const service = createServiceClient();
  if (requested.data === '') {
    const { error } = await service.from('user_routing_provider').delete().eq('user_id', user.id);
    if (error) return 'Could not reset your default provider. Refresh and try again.';
  } else {
    const [sources, plan, names] = await Promise.all([listSources(), loadPlan(user.id), loadRoutingProviderNames()]);
    const provider = selectableRoutingProviders(
      sources.filter((source) => source.status !== 'off' && planMeetsMinimum(plan.key, source.min_plan)),
      names,
    ).find((item) => item.publicId === requested.data);
    if (!provider) return 'This provider is unavailable on your plan.';
    const { error } = await service.from('user_routing_provider').upsert(
      { user_id: user.id, provider_id: provider.id, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
    if (error) return 'Could not save your default provider. Refresh and try again.';
  }
  revalidatePath('/dashboard/routing');
  revalidatePath('/dashboard/chat');
  return requested.data === '' ? 'Auto will use the platform default provider.' : 'Default provider saved.';
}

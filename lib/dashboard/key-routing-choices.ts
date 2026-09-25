import { FAMILIES, FAMILY_LABELS, MODALITIES, MODALITY_LABELS, routingKey, type Family, type Modality } from '@/lib/ai/source-types';
import { listSources, type Source } from '@/lib/ai/sources';
import { loadRoutingProviderNames } from '@/lib/ai/routing-provider-names';
import { publicRoutingSourceId, publicRoutingText, selectableRoutingProviders, type SelectableRoutingProvider } from '@/lib/ai/routing-provider';
import { planMeetsMinimum } from '@/lib/billing/plans';
import { groupRoutingProviders } from './routing-catalog';
import { listModelCatalog } from './queries';

/** One source a key can be pinned to, by public id only. */
export interface KeySourceChoice {
  id: string;
  label: string;
  description: string;
  multiplier: string;
}

export interface KeyRoutingPair {
  /** `family:modality`, the same key the owner's preferences use. */
  key: string;
  family: Family;
  modality: Modality;
  label: string;
  sources: KeySourceChoice[];
}

export interface KeyRoutingChoices {
  providers: SelectableRoutingProvider[];
  pairs: KeyRoutingPair[];
  /** Internal source rows behind `pairs`, for mapping a posted public id back. Server only. */
  eligibleSources: Source[];
}

/**
 * The providers and per-family sources a key on `planKey` may be pinned to.
 * Same eligibility as the Routing page: the source is on, the plan reaches it,
 * and it actually serves models in the catalogue.
 */
export async function loadKeyRoutingChoices(planKey: string): Promise<KeyRoutingChoices> {
  const [sources, catalog, names] = await Promise.all([listSources(), listModelCatalog(), loadRoutingProviderNames()]);
  const models = catalog.filter((model) => !model.isByok && planMeetsMinimum(planKey, model.minPlan));
  const providers = groupRoutingProviders(models, names);
  const sourceProviders = new Map(providers.flatMap((provider) => provider.sourceIds.map((id) => [id, provider] as const)));
  const eligibleSources = sources.filter((source) =>
    source.status !== 'off' && planMeetsMinimum(planKey, source.min_plan) &&
    sourceProviders.has(publicRoutingSourceId(source.id)));
  const pairs = FAMILIES.flatMap((family) => MODALITIES.flatMap((modality) => {
    const eligible = eligibleSources.filter((source) => source.family === family && source.modality === modality);
    return eligible.length ? [{
      key: routingKey(family, modality),
      family,
      modality,
      label: `${FAMILY_LABELS[family]} · ${MODALITY_LABELS[modality]}`,
      sources: eligible.map((source) => ({
        id: publicRoutingSourceId(source.id),
        label: sourceProviders.get(publicRoutingSourceId(source.id))!.label,
        description: publicRoutingText(source.description, names),
        multiplier: source.credit_multiplier,
      })),
    }] : [];
  }));
  return { providers: selectableRoutingProviders(eligibleSources, names), pairs, eligibleSources };
}

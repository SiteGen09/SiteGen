import { MODALITIES, MODALITY_LABELS, type Family, type Modality } from '@/lib/ai/source-types';
import {
  publicRoutingProviderIdentity,
  publicRoutingProviderIdentityFromIdentity,
  publicRoutingSourceId,
  publicRoutingText,
} from '@/lib/ai/routing-provider';
import type { PublicBillingPolicy } from '@/lib/ai/billing-policy';
import type { ModelCatalogEntry } from './queries';

/** Explicit public projection: upstream model IDs and endpoint URLs stay on the server. */
export interface RoutingModel {
  id: string;
  publicModelId: string;
  label: string;
  family: Family | null;
  modality: Modality;
  status: string;
  minPlan: ModelCatalogEntry['minPlan'];
  creditMultiplier: number;
  inputCreditsPerMTok: number;
  outputCreditsPerMTok: number;
  cachedCreditsPerMTok: number;
  requestCredits: number | null;
  requestPriceKind?: ModelCatalogEntry['requestPriceKind'];
  billingPolicy?: PublicBillingPolicy | null;
}

export interface RoutingProvider {
  id: string;
  label: string;
  description: string;
  sourceIds: string[];
  modalities: Modality[];
  models: RoutingModel[];
}

export function groupRoutingProviders(catalog: readonly ModelCatalogEntry[]): RoutingProvider[] {
  const groups = new Map<string, RoutingProvider>();
  const descriptions = new Map<string, Set<string>>();
  for (const model of catalog) {
    if (model.isByok || model.status === 'off' || model.sourceId === null) continue;
    const identity = model.routingProvider
      ? publicRoutingProviderIdentityFromIdentity(model.routingProvider)
      : publicRoutingProviderIdentity({
          sourceId: model.sourceId, sourceLabel: model.sourceLabel, provider: model.provider,
        });
    let group = groups.get(identity.id);
    if (!group) {
      group = { ...identity, description: '', sourceIds: [], modalities: [], models: [] };
      groups.set(identity.id, group);
      descriptions.set(identity.id, new Set());
    }
    const publicSourceId = publicRoutingSourceId(model.sourceId);
    if (!group.sourceIds.includes(publicSourceId)) group.sourceIds.push(publicSourceId);
    if (!group.modalities.includes(model.modality)) group.modalities.push(model.modality);
    const description = publicRoutingText(model.sourceDescription.trim());
    // Catalog imports used to generate a separate description for every family.
    if (description && !/^kie\.ai (chat|image|video) models from /i.test(description)) {
      descriptions.get(identity.id)!.add(description);
    }
    group.models.push({
      id: model.id, publicModelId: model.publicModelId, label: model.label,
      family: model.family, modality: model.modality, status: model.status, minPlan: model.minPlan,
      creditMultiplier: model.creditMultiplier,
      inputCreditsPerMTok: model.inputCreditsPerMTok,
      outputCreditsPerMTok: model.outputCreditsPerMTok,
      cachedCreditsPerMTok: model.cachedCreditsPerMTok,
      requestCredits: model.requestCredits,
      requestPriceKind: model.requestPriceKind,
      ...(model.billingPolicy ? { billingPolicy: model.billingPolicy } : {}),
    });
  }
  for (const group of groups.values()) {
    group.modalities.sort((a, b) => MODALITIES.indexOf(a) - MODALITIES.indexOf(b));
    group.models.sort((a, b) => a.label.localeCompare(b.label) || a.modality.localeCompare(b.modality));
    const configured = [...descriptions.get(group.id)!];
    group.description = configured.length === 1
      ? configured[0]!
      : group.modalities.map((kind) => MODALITY_LABELS[kind]).join(', ') +
        ' models from multiple model families, with individual prices configured below.';
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

import type { ModelCatalogEntry } from './queries';
import type { ModelStatusRow } from './model-status';
import { FAMILY_LABELS } from '@/lib/ai/source-types';
import type { PlanKey } from '@/lib/billing/plans';

export interface ModelCatalogFilters {
  query?: string;
  status?: string;
  family?: string;
  modality?: string;
  pricing?: string;
  source?: string;
  plan?: string;
  planAccess?: 'included' | 'upgrade';
  availablePlanRank?: number;
  access?: string;
  maxInput?: number;
  maxOutput?: number;
  maxCached?: number;
  maxRequest?: number;
}

function searchMatches(query: string | undefined, fields: readonly (string | null | undefined)[]): boolean {
  const terms = query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
  if (terms.length === 0) return true;
  const haystack = fields.filter(Boolean).join(' ').toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterModelCatalog(
  models: readonly ModelCatalogEntry[],
  filters: ModelCatalogFilters,
): ModelCatalogEntry[] {
  return models.filter((model) => {
    const pricing = model.pricingType;
    return (
      searchMatches(filters.query, [
        model.publicModelId, model.label, model.routingProvider?.label, model.provider,
        model.sourceLabel, model.sourceDescription, model.family,
        model.family === null ? undefined : FAMILY_LABELS[model.family], model.modality, model.minPlan,
        model.isByok ? 'byok your own key' : 'credits', model.pricingType,
        String(model.inputCreditsPerMTok), String(model.outputCreditsPerMTok),
        String(model.cachedCreditsPerMTok), model.requestCredits === null ? '' : String(model.requestCredits),
      ]) &&
      (!filters.status || model.status === filters.status) &&
      (!filters.family || model.family === filters.family) &&
      (!filters.modality || model.modality === filters.modality) &&
      (!filters.pricing || pricing === filters.pricing) &&
      (!filters.source || model.sourceLabel === filters.source) &&
      (!filters.plan || model.minPlan === filters.plan) &&
      (!filters.planAccess || (filters.availablePlanRank !== undefined &&
        (filters.planAccess === 'included'
          ? filters.availablePlanRank >= (PLAN_RANK[model.minPlan] ?? 0)
          : filters.availablePlanRank < (PLAN_RANK[model.minPlan] ?? 0)))) &&
      (!filters.access || (filters.access === 'byok' ? model.isByok : !model.isByok)) &&
      (filters.maxInput === undefined ||
        (!model.isByok && pricing === 'token' && model.inputCreditsPerMTok <= filters.maxInput)) &&
      (filters.maxOutput === undefined ||
        (!model.isByok && pricing === 'token' && model.outputCreditsPerMTok <= filters.maxOutput)) &&
      (filters.maxCached === undefined ||
        (!model.isByok && pricing === 'token' && model.cachedCreditsPerMTok <= filters.maxCached)) &&
      (filters.maxRequest === undefined ||
        (!model.isByok && pricing === 'request' && model.requestCredits !== null && model.requestCredits <= filters.maxRequest))
    );
  });
}

const PLAN_RANK: Record<PlanKey, number> = { free: 0, starter: 1, pro: 2, max: 3 };

export interface ModelStatusFilters {
  query?: string;
  health?: ModelStatusRow['health'];
}

export function filterModelStatusRows<T extends ModelStatusRow>(
  rows: readonly T[],
  filters: ModelStatusFilters,
): T[] {
  return rows.filter(
    (row) =>
      searchMatches(filters.query, [
        row.publicModelId,
        row.label,
        row.health,
        row.health === 'idle' ? 'no recent traffic no data' : row.health,
      ]) &&
      (!filters.health || row.health === filters.health),
  );
}

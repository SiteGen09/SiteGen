import type { BillingPolicy, PublicBillingPolicy } from '@/lib/ai/billing-policy';
import type { Modality } from '@/lib/ai/source-types';

export type RequestPriceKind = 'fixed' | 'from' | 'up_to';

/** Kie imports a reservation ceiling; Relay publishes fixed image-size tiers. */
export function requestPriceKind(provider: string, policy?: BillingPolicy | PublicBillingPolicy | null): RequestPriceKind {
  if (provider === 'kie_jobs') return 'up_to';
  return policy?.imagePrices && policy.imagePrices.standard !== policy.imagePrices.large ? 'from' : 'fixed';
}

/** Only this safe projection crosses the public page's client boundary. */
export interface PublicPrice {
  model: string;
  label: string;
  group: string;
  vendor: string;
  contextWindow: number | null;
  endpoints: string[];
  tags: string[];
  pricingType: 'token' | 'request';
  status: 'active' | 'degraded';
  modality: Modality;
  providerId: string;
  sourceLabel: string;
  multiplier: number;
  /** Null means this billing unit does not apply, never a free price. */
  input: number | null;
  output: number | null;
  cached: number | null;
  request: number | null;
  requestPriceKind: RequestPriceKind | null;
  listInput: number | null;
  listOutput: number | null;
  listCached: number | null;
  listRequest: number | null;
  billingPolicy?: PublicBillingPolicy | null;
}

export type PriceSort = 'input' | 'output' | 'request';

/** Match every useful catalog label, including metadata hidden in table columns. */
export function matchesPublicPriceSearch(row: PublicPrice, search: string): boolean {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [
    row.model, row.label, row.vendor, row.sourceLabel, row.group, row.modality,
    row.pricingType, row.status, ...row.tags, ...row.endpoints,
    row.contextWindow === null ? '' : String(row.contextWindow),
    row.input, row.output, row.cached, row.request, row.listInput, row.listOutput,
    row.listCached, row.listRequest,
  ].join(' ').toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Inapplicable or unpublished prices stay last in either sort direction. */
export function comparePublicPrices(a: PublicPrice, b: PublicPrice, key: PriceSort, ascending: boolean): number {
  const left = a[key];
  const right = b[key];
  if (left === null && right !== null) return 1;
  if (left !== null && right === null) return -1;
  return (left !== null && right !== null ? (ascending ? 1 : -1) * (left - right) : 0) ||
    a.model.localeCompare(b.model) || a.sourceLabel.localeCompare(b.sourceLabel);
}

/** No badge for missing, zero, or lower list prices: never invent a discount. */
export function discountPercent(price: number, listPrice: number | null): number | null {
  if (listPrice === null || listPrice <= 0 || price >= listPrice) return null;
  const discount = Math.round((1 - price / listPrice) * 100);
  return discount > 0 ? discount : null;
}

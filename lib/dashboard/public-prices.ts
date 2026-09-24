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

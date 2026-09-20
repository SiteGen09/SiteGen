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
  sourceLabel: string;
  multiplier: number;
  input: number;
  output: number;
  cached: number;
  listInput: number | null;
  listOutput: number | null;
  listCached: number | null;
}

/** No badge for missing, zero, or lower list prices: never invent a discount. */
export function discountPercent(price: number, listPrice: number | null): number | null {
  if (listPrice === null || listPrice <= 0 || price >= listPrice) return null;
  const discount = Math.round((1 - price / listPrice) * 100);
  return discount > 0 ? discount : null;
}

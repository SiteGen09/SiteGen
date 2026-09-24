/** Public USD catalog. All purchase arithmetic uses integer cents. */
export const CREDITS_PER_USD = 10_000;
export const MIN_TOPUP_CENTS = 100;
// Whop requires approval for checkout links above $2,500.
export const MAX_TOPUP_CENTS = 250_000;
export const TOPUP_PRESETS = [500, 1_000, 2_500, 5_000] as const;
export const BILLING_TERMS_VERSION = '2026-09-22';

export function parseUsdCents(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('Enter a USD amount with at most two decimal places.');
  }
  const [dollars = '0', fraction = ''] = value.split('.');
  return Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
}

export function topupQuote(cents: number) {
  if (!Number.isSafeInteger(cents) || cents < MIN_TOPUP_CENTS || cents > MAX_TOPUP_CENTS) {
    throw new Error('Choose an amount from $1.00 to $2,500.00 USD.');
  }
  const baseCredits = cents * (CREDITS_PER_USD / 100);
  return { cents, baseCredits, bonusPercent: 0, bonusCredits: 0, credits: baseCredits };
}

/** Whole credits round up to cents; buyers receive all credits the charge buys. */
export function quoteFromCredits(value: unknown): ReturnType<typeof topupQuote> {
  const text = String(value);
  if (!/^\d{1,10}$/.test(text)) throw new Error('Enter a positive whole credit quantity.');
  const credits = Number(text);
  if (!Number.isSafeInteger(credits) || credits <= 0) throw new Error('Enter a positive whole credit quantity.');
  const cents = Math.max(MIN_TOPUP_CENTS, Math.ceil(credits / (CREDITS_PER_USD / 100)));
  return topupQuote(cents);
}

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

import { z } from 'zod';

const rate = z.number().finite().nonnegative();
export const rateSchema = z.object({
  inputPerMTok: rate, outputPerMTok: rate, cachedPerMTok: rate,
  cacheWritePerMTok: rate.optional(),
});
const tiersSchema = z.array(z.object({ name: z.string(), rates: rateSchema })).min(1);
const positive = z.number().finite().positive();

/**
 * Relay bills each family at the unit price of the source selected in the
 * Relay account (GPT Plus/Pro, Claude Max, ...), not at the catalog's default.
 * `baseTiers` are the catalog rates at `factor` (the catalog group ratio times
 * the model's billing multiplier); `tiers` are those times `scale`, the ratio
 * of what Relay currently bills to `factor`. Keeping the base makes repeated
 * source switches exact rather than compounding float error.
 */
export const sourcePricingSchema = z.object({
  relayFamily: z.string().min(1),
  factor: positive,
  billingMultiplier: positive,
  baseTiers: tiersSchema,
  scale: positive,
  tier: z.string().nullable(),
  label: z.string().nullable(),
});
export type SourcePricing = z.infer<typeof sourcePricingSchema>;

export const billingPolicySchema = z.object({
  origin: z.enum(['relay.fast', 'kie.ai']),
  version: z.string(),
  syncedAt: z.string(),
  tiers: tiersSchema,
  contextThreshold: z.number().int().positive().optional(),
  peakUtcHours: z.array(z.tuple([z.number().int().min(0).max(23), z.number().int().min(1).max(24)])).optional(),
  imagePrices: z.object({ standard: rate, large: rate }).optional(),
  sourcePricing: sourcePricingSchema.optional(),
}).superRefine((policy, ctx) => {
  if (policy.contextThreshold !== undefined && policy.tiers.length !== 2) ctx.addIssue({ code: 'custom', message: 'Context pricing requires two tiers' });
  if (policy.peakUtcHours && (!policy.tiers.some(t => t.name === 'peak') || !policy.tiers.some(t => t.name === 'off_peak'))) ctx.addIssue({ code: 'custom', message: 'Time pricing requires peak and off-peak tiers' });
  if (policy.sourcePricing && policy.sourcePricing.baseTiers.map(t => t.name).join() !== policy.tiers.map(t => t.name).join()) ctx.addIssue({ code: 'custom', message: 'Source pricing must scale the same tiers' });
});
export type BillingPolicy = z.infer<typeof billingPolicySchema>;

/**
 * Consumer-safe projection. The upstream origin and the upstream source
 * (whose label names the reseller's account type) are deliberately omitted.
 */
export type PublicBillingPolicy = Omit<BillingPolicy, 'origin' | 'sourcePricing'>;

export function publicBillingPolicy(policy: BillingPolicy | null | undefined): PublicBillingPolicy | null {
  if (!policy) return null;
  const { origin: _origin, sourcePricing: _sourcePricing, ...publicPolicy } = policy;
  return publicPolicy;
}

/** Rates are stored rounded to 12 significant digits so a rescale is idempotent. */
function roundRate(value: number): number {
  return Number(value.toPrecision(12));
}

/** `baseTiers` repriced at `scale`. */
export function scaleTiers(baseTiers: BillingPolicy['tiers'], scale: number): BillingPolicy['tiers'] {
  return baseTiers.map((tier) => ({
    name: tier.name,
    rates: Object.fromEntries(
      Object.entries(tier.rates).map(([key, value]) => [key, value === undefined ? value : roundRate(value * scale)]),
    ) as typeof tier.rates,
  }));
}

/** Freeze time-of-day pricing when the request resolves its channel. */
export function policyRates(policy: BillingPolicy, now = new Date()) {
  if (policy.peakUtcHours) {
    const peak = policy.peakUtcHours.some(([from, to]) => now.getUTCHours() >= from && now.getUTCHours() < to);
    const tier = policy.tiers.find(t => t.name === (peak ? 'peak' : 'off_peak'));
    if (!tier) throw new Error('Missing time pricing tier');
    return tier.rates;
  }
  return {
    ...policy.tiers[0]!.rates,
    ...(policy.contextThreshold === undefined ? {} : {
      longContext: { threshold: policy.contextThreshold, ...policy.tiers[1]!.rates },
    }),
  };
}

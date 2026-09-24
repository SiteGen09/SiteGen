import { z } from 'zod';

const rate = z.number().finite().nonnegative();
export const rateSchema = z.object({
  inputPerMTok: rate, outputPerMTok: rate, cachedPerMTok: rate,
  cacheWritePerMTok: rate.optional(),
});
export const billingPolicySchema = z.object({
  origin: z.literal('relay.fast'),
  version: z.string(),
  syncedAt: z.string(),
  tiers: z.array(z.object({ name: z.string(), rates: rateSchema })).min(1),
  contextThreshold: z.number().int().positive().optional(),
  peakUtcHours: z.array(z.tuple([z.number().int().min(0).max(23), z.number().int().min(1).max(24)])).optional(),
  imagePrices: z.object({ standard: rate, large: rate }).optional(),
}).superRefine((policy, ctx) => {
  if (policy.contextThreshold !== undefined && policy.tiers.length !== 2) ctx.addIssue({ code: 'custom', message: 'Context pricing requires two tiers' });
  if (policy.peakUtcHours && (!policy.tiers.some(t => t.name === 'peak') || !policy.tiers.some(t => t.name === 'off_peak'))) ctx.addIssue({ code: 'custom', message: 'Time pricing requires peak and off-peak tiers' });
});
export type BillingPolicy = z.infer<typeof billingPolicySchema>;

/** Consumer-safe projection. The upstream origin is deliberately omitted. */
export type PublicBillingPolicy = Omit<BillingPolicy, 'origin'>;

export function publicBillingPolicy(policy: BillingPolicy | null | undefined): PublicBillingPolicy | null {
  if (!policy) return null;
  const { origin: _origin, ...publicPolicy } = policy;
  return publicPolicy;
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

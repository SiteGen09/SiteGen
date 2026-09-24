/**
 * Plan definitions — the internal source of truth for what a tier includes.
 * Whop plan ids map to these internal plan keys; Whop is only the payment
 * rail. Server-side only (reads env).
 */

export const PLAN_KEYS = ['free', 'starter', 'pro', 'max'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export interface PlanDef {
  key: PlanKey;
  label: string;
  priceCents: number;
  /** Whop plan id (null = not purchasable, e.g. free). */
  whopPlanId: string | null;
  /** Credits granted on each period renewal. */
  monthlyCredits: number;
  /** Default requests-per-minute for API keys on this plan. */
  rateLimitRpm: number;
  /** Ordering for channels.min_plan comparisons. */
  rank: number;
  /**
   * Largest `max_tokens` a gateway chat request may ask for on this plan. A
   * request above it is rejected, not clamped, so the caller's cost estimate
   * and ours stay in agreement.
   */
  maxOutputTokens: number;
}

function configuredPlanId(value: string | undefined): string | null {
  return value?.startsWith('plan_') ? value : null;
}

export function getPlans(): Record<PlanKey, PlanDef> {
  return {
    free: {
      key: 'free',
      label: 'Free',
      priceCents: 0,
      whopPlanId: null,
      monthlyCredits: 0,
      rateLimitRpm: 20,
      rank: 0,
      maxOutputTokens: 1024,
    },
    starter: {
      key: 'starter',
      label: 'Starter',
      priceCents: 1499,
      whopPlanId: configuredPlanId(process.env.WHOP_PLAN_STARTER),
      monthlyCredits: 149_000,
      rateLimitRpm: 60,
      rank: 1,
      maxOutputTokens: 4096,
    },
    pro: {
      key: 'pro',
      label: 'Pro',
      priceCents: 2999,
      whopPlanId: configuredPlanId(process.env.WHOP_PLAN_PRO),
      monthlyCredits: 299_000,
      rateLimitRpm: 300,
      rank: 2,
      maxOutputTokens: 16384,
    },
    max: {
      key: 'max',
      label: 'Max',
      priceCents: 4999,
      whopPlanId: configuredPlanId(process.env.WHOP_PLAN_MAX),
      monthlyCredits: 499_000,
      rateLimitRpm: 300,
      rank: 3,
      maxOutputTokens: 16384,
    },
  };
}

export function isPlanKey(value: string): value is PlanKey {
  return (PLAN_KEYS as readonly string[]).includes(value);
}

export function planKeyFromWhopPlanId(whopPlanId: string): PlanKey | null {
  const plans = getPlans();
  for (const key of PLAN_KEYS) {
    if (plans[key].whopPlanId === whopPlanId) return key;
  }
  return null;
}

/** True when the user's plan meets a channel's min_plan requirement. */
export function planMeetsMinimum(userPlan: string, minPlan: string): boolean {
  const plans = getPlans();
  const userRank = isPlanKey(userPlan) ? plans[userPlan].rank : 0;
  const minRank = isPlanKey(minPlan) ? plans[minPlan].rank : 0;
  return userRank >= minRank;
}

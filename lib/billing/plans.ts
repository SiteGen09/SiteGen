/**
 * Plan definitions — the internal source of truth for what a tier includes.
 * Whop plan ids map to these internal plan keys; Whop is only the payment
 * rail. Server-side only (reads env).
 */

export const PLAN_KEYS = ['free', 'starter', 'pro'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export interface PlanDef {
  key: PlanKey;
  label: string;
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

export function getPlans(): Record<PlanKey, PlanDef> {
  return {
    free: {
      key: 'free',
      label: 'Free',
      whopPlanId: null,
      monthlyCredits: 0,
      rateLimitRpm: 20,
      rank: 0,
      maxOutputTokens: 1024,
    },
    starter: {
      key: 'starter',
      label: 'Starter',
      whopPlanId: process.env.WHOP_PLAN_STARTER ?? null,
      monthlyCredits: 500_000,
      rateLimitRpm: 60,
      rank: 1,
      maxOutputTokens: 4096,
    },
    pro: {
      key: 'pro',
      label: 'Pro',
      whopPlanId: process.env.WHOP_PLAN_PRO ?? null,
      monthlyCredits: 2_500_000,
      rateLimitRpm: 300,
      rank: 2,
      maxOutputTokens: 16384,
    },
  };
}

/** One-off credit top-up product. */
export function getTopupProduct(): { whopPlanId: string | null; credits: number } {
  return {
    whopPlanId: process.env.WHOP_PLAN_TOPUP ?? null,
    credits: 100_000,
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

import type { PublicBillingPolicy } from '@/lib/ai/billing-policy';
import { creditsForUsage } from '@/lib/ai/pricing';

export function BillingDetails({ policy, multiplier }: { policy?: PublicBillingPolicy | null; multiplier: number }) {
  if (!policy) return null;
  const price = (usd: number) => creditsForUsage(usd, multiplier).toLocaleString('en-US');
  return <details className="mt-2 max-w-md text-xs text-zinc-600">
    <summary className="cursor-pointer underline">Pricing details</summary>
    <div className="mt-2 space-y-2">
      <p>Prices include the platform markup. One credit is $0.0001. Each completed call rounds up to a whole credit.</p>
      {policy.contextThreshold && <p>Long-context rates apply to the whole request above {policy.contextThreshold.toLocaleString('en-US')} input tokens, including cached input.</p>}
      {policy.peakUtcHours && <p>Peak rates: 01:00–04:00 and 06:00–10:00 UTC. The request&apos;s start time selects its rate.</p>}
      {policy.imagePrices ? <p>One image per job. Up to 1792 px: {price(policy.imagePrices.standard)} credits; larger images: {price(policy.imagePrices.large)} credits.</p> :
        policy.tiers.map(tier => <p key={tier.name}><strong>{tier.name.replaceAll('_', ' ')}:</strong> {price(tier.rates.inputPerMTok)} input / {price(tier.rates.outputPerMTok)} output / {price(tier.rates.cachedPerMTok)} cache read{tier.rates.cacheWritePerMTok === undefined ? '' : ' / ' + price(tier.rates.cacheWritePerMTok) + ' cache write'} credits per million tokens.</p>)}
      <p>Rates synced {policy.syncedAt.slice(0, 10)}. Choose the matching provider alias under Routing to use these prices for a model offered by multiple sources.</p>
    </div>
  </details>;
}

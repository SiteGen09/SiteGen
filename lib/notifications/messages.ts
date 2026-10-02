import { billingPolicySchema, policyRates } from '@/lib/ai/billing-policy';
import { USD_PER_CREDIT } from '@/lib/ai/pricing';

import { BODY_MAX, TITLE_MAX } from './types';

/**
 * Wording for scanner notifications. Pure: the scanner supplies what changed
 * and these decide what a consumer reads. Prices are what consumers pay,
 * provider rate times the source markup, never the provider's own rate.
 */

export type ConsumerPrice =
  | { kind: 'token'; input: number; output: number }
  | { kind: 'request'; perJob: number };

const priceSnapshot = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The consumer price in a `routing_price_snapshot` of a channel (or the live
 * row, which has the same columns), at `multiplier`. Null when the snapshot
 * carries no usable price.
 */
export function consumerPrice(snapshot: unknown, multiplier: number): ConsumerPrice | null {
  const row = priceSnapshot(snapshot);
  const policy = billingPolicySchema.safeParse(row.billing_policy);
  if (row.pricing_type === 'request') {
    const perJob = policy.success && policy.data.imagePrices
      ? policy.data.imagePrices.standard
      : number(row.request_price_usd);
    return perJob === null ? null : { kind: 'request', perJob: perJob * multiplier };
  }
  if (policy.success) {
    const rates = policyRates(policy.data, new Date(0));
    return { kind: 'token', input: rates.inputPerMTok * multiplier, output: rates.outputPerMTok * multiplier };
  }
  const input = number(row.input_per_mtok);
  const output = number(row.output_per_mtok);
  return input === null || output === null ? null : { kind: 'token', input: input * multiplier, output: output * multiplier };
}

/** Whether two prices differ by more than rounding noise (0.5%). */
export function priceChanged(before: ConsumerPrice, after: ConsumerPrice): boolean {
  const moved = (a: number, b: number) => Math.abs(a - b) > Math.max(a, b) * 0.005;
  if (before.kind !== after.kind) return true;
  if (before.kind === 'request' && after.kind === 'request') return moved(before.perJob, after.perJob);
  if (before.kind === 'token' && after.kind === 'token') return moved(before.input, after.input) || moved(before.output, after.output);
  return false;
}

/** Positive for an increase: the largest relative move of any component. */
export function priceMove(before: ConsumerPrice, after: ConsumerPrice): number {
  const ratio = (a: number, b: number) => (a === 0 ? (b === 0 ? 0 : 1) : b / a - 1);
  if (before.kind === 'request' && after.kind === 'request') return ratio(before.perJob, after.perJob);
  if (before.kind === 'token' && after.kind === 'token') {
    const moves = [ratio(before.input, after.input), ratio(before.output, after.output)];
    return moves.reduce((best, move) => (Math.abs(move) > Math.abs(best) ? move : best), 0);
  }
  return 0;
}

/** Four significant digits: enough for sub-cent token rates, without float noise. */
export function usd(value: number): string {
  return `$${Number(value.toPrecision(4)).toString()}`;
}

/** An amount of money a person holds or spends, in cents. */
function dollars(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface PriceChangeLine {
  model: string;
  provider: string;
  before: ConsumerPrice;
  after: ConsumerPrice;
}

export function priceChangeLine({ model, provider, before, after }: PriceChangeLine): string {
  if (before.kind === 'token' && after.kind === 'token') {
    return `${model} (${provider}): input ${usd(before.input)} → ${usd(after.input)}, output ${usd(before.output)} → ${usd(after.output)} per 1M tokens`;
  }
  if (before.kind === 'request' && after.kind === 'request') {
    return `${model} (${provider}): ${usd(before.perJob)} → ${usd(after.perJob)} per request`;
  }
  return `${model} (${provider}): pricing changed`;
}

const LIST_LIMIT = 25;
/** Price increases this large or larger are flagged important (dashboard banner). */
export const IMPORTANT_INCREASE = 0.25;

export interface Draft {
  title: string;
  body: string;
  link: string;
  important: boolean;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function listed(lines: string[], more: string): string {
  const shown = lines.slice(0, LIST_LIMIT);
  const rest = lines.length - shown.length;
  return [...shown.map((line) => `• ${line}`), ...(rest > 0 ? [`…and ${rest} more. ${more}`] : [])].join('\n');
}

export function priceChangeNotice(changes: PriceChangeLine[]): Draft {
  const moves = changes.map((change) => priceMove(change.before, change.after));
  const direction = moves.every((move) => move > 0) ? 'increase' : moves.every((move) => move < 0) ? 'decrease' : 'change';
  const models = [...new Set(changes.map((change) => change.model))];
  const title = models.length === 1
    ? `Price ${direction}: ${models[0]}`
    : `Price ${direction === 'change' ? 'changes' : `${direction}s`} for ${models.length} models`;
  return {
    title: clip(title, TITLE_MAX),
    body: clip(`New prices apply to requests from now on.\n\n${listed(changes.map(priceChangeLine), 'See the Prices page for the full list.')}`, BODY_MAX),
    link: '/prices',
    important: moves.some((move) => move >= IMPORTANT_INCREASE),
  };
}

export interface ModelChange {
  model: string;
  modality: string;
  /** Plan label when the model needs more than the free plan. */
  planLabel: string | null;
}

function describe(change: ModelChange): string {
  const parts = [change.modality === 'chat' ? null : `${change.modality} model`, change.planLabel ? `${change.planLabel} plan and above` : null]
    .filter(Boolean);
  return parts.length ? `${change.model} (${parts.join(', ')})` : change.model;
}

export function modelsAddedNotice(added: ModelChange[]): Draft {
  const title = added.length === 1 ? `New model: ${added[0]!.model}` : `${added.length} new models available`;
  const body = added.length === 1
    ? `${describe(added[0]!)} is now available. Use it by name in your API requests or pick it in Chat.`
    : `Now available. Use them by name in your API requests or pick them in Chat.\n\n${listed(added.map(describe), 'See the Models page.')}`;
  return { title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX), link: '/dashboard/models', important: false };
}

export function modelsRemovedNotice(removed: ModelChange[]): Draft {
  const title = removed.length === 1 ? `Model removed: ${removed[0]!.model}` : `${removed.length} models removed`;
  const body = removed.length === 1
    ? `${removed[0]!.model} is no longer available. Requests that name it will fail; switch them to another model.`
    : `These models are no longer available. Requests that name them will fail; switch them to another model.\n\n${listed(removed.map((change) => change.model), 'See the Models page.')}`;
  return { title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX), link: '/dashboard/models', important: true };
}

export function lowBalanceNotice(balanceCredits: number): Draft {
  return {
    title: 'Your credit balance is low',
    body: `Your balance is ${dollars(Math.max(0, balanceCredits) * USD_PER_CREDIT)}. Requests are refused once it runs out, so top up to keep your API keys and apps working.`,
    link: '/dashboard/billing',
    important: true,
  };
}

export function keyExpiringNotice(name: string, expiresAt: Date): Draft {
  return {
    title: clip(`API key "${name}" expires soon`, TITLE_MAX),
    body: `It stops working on ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC. Create a new key or change its expiry under API Keys before then.`,
    link: '/dashboard/keys',
    important: false,
  };
}

export function keyQuotaNotice(name: string, usedCredits: number, quotaCredits: number, exhausted: boolean): Draft {
  const used = dollars(usedCredits * USD_PER_CREDIT);
  const quota = dollars(quotaCredits * USD_PER_CREDIT);
  return exhausted
    ? {
        title: clip(`API key "${name}" reached its spending limit`, TITLE_MAX),
        body: `It has used ${used} of its ${quota} limit, so its requests are now refused. Raise the limit under API Keys to keep it working.`,
        link: '/dashboard/keys',
        important: true,
      }
    : {
        title: clip(`API key "${name}" has used 80% of its limit`, TITLE_MAX),
        body: `It has used ${used} of its ${quota} limit. Requests are refused once it is reached.`,
        link: '/dashboard/keys',
        important: false,
      };
}

export interface UpstreamAlert {
  /** Internal provider name, such as relay.fast. Admins only, so it is not aliased. */
  provider: string;
  family: string;
  failed: number;
  succeeded: number;
  windowMinutes: number;
  topErrors: string[];
}

/** For administrators: an upstream is failing often enough to act on. */
export function upstreamAlertNotice(alert: UpstreamAlert): Draft {
  const attempts = alert.failed + alert.succeeded;
  const rate = Math.round((alert.failed / attempts) * 100);
  const errors = alert.topErrors.length ? ` Most common: ${alert.topErrors.join(', ')}.` : '';
  return {
    title: clip(`${alert.provider} ${alert.family} failing: ${rate}% of attempts in the last ${alert.windowMinutes} minutes`, TITLE_MAX),
    body: clip(
      `${alert.failed} of ${attempts} attempts on ${alert.provider} ${alert.family} models failed in the last ${alert.windowMinutes} minutes.${errors}

` +
        'Requests were retried on other providers where one serves the same model. To act, switch the source ' +
        `in the ${alert.provider} dashboard, or turn the source off under Admin → Sources. This alert repeats at most once an hour.`,
      BODY_MAX,
    ),
    link: '/admin/sources',
    important: true,
  };
}

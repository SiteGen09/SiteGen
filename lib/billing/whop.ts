/**
 * Whop integration: webhook verification, payload schemas, entitlement/ledger
 * application and the REST reads used by reconciliation. Server-only — reads
 * WHOP_WEBHOOK_SECRET / WHOP_API_KEY and writes with the service client.
 *
 * REST contract pinned to 2026-09-15; Whop docs reviewed 2026-09-21:
 *  - Webhooks (Standard Webhooks signing, delivery + retry semantics):
 *    https://docs.whop.com/developer/guides/webhooks
 *    · headers `webhook-id`, `webhook-timestamp`, `webhook-signature`
 *      (contractually frozen across API versions)
 *    · signed string is `{webhook-id}.{webhook-timestamp}.{raw body}`,
 *      HMAC-SHA256 with the `ws_...` secret, base64, header value `v1,<sig>`
 *    · reject when `webhook-timestamp` is more than 5 minutes off
 *    · at-least-once delivery, unordered: handlers must be idempotent and may
 *      re-read state from the API
 *  - Membership resource (`plan_id`, `status`, `user_id`, `current_period_end`,
 *    `metadata`): https://docs.whop.com/api-reference/beta/memberships/membership
 *  - List Memberships (`GET /memberships`, cursor paging via
 *    `page_info.end_cursor` + `after`, `first` max 100):
 *    https://docs.whop.com/api-reference/beta/memberships/list-memberships
 *  - Checkout configurations carry `metadata` "copied to payments and
 *    memberships" — that is how our user id reaches the webhook:
 *    https://docs.whop.com/api-reference/beta/checkout-configurations/create-a-checkout-configuration
 *
 * Legacy field/event spellings (`membership_went_valid`, `renewal_period_end`,
 * `user: { id, email }`) are accepted because webhooks pinned to an older
 * `api_version_date` keep their original payload shape.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  getPlans,
  isPlanKey,
  planKeyFromWhopPlanId,
  type PlanKey,
} from '@/lib/billing/plans';
import { logger, type Logger } from '@/lib/log';
import { createWhopClient } from './whop-client';

const WHOP_API_BASE = 'https://api.whop.com/api/v1';
/** Docs: reject a delivery whose `webhook-timestamp` is more than 5 minutes off. */
const SIGNATURE_TOLERANCE_SECONDS = 300;
/** `first` is capped at 100 by the List Memberships endpoint. */
const MEMBERSHIP_PAGE_SIZE = 100;

/**
 * Billing states the List Memberships `status` filter accepts (docs:
 * api-reference/beta/memberships/list-memberships).
 */
export const WHOP_BILLING_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'completed',
  'canceled',
  'expired',
  'canceling',
  'paused',
] as const;
export type WhopBillingStatus = (typeof WHOP_BILLING_STATUSES)[number];

/**
 * Statuses that still carry access: `canceling` is an active membership set to
 * cancel at period end, `trialing` is a live trial. Reconciliation pages all
 * three before deciding a local entitlement is stale.
 */
export const ENTITLED_WHOP_STATUSES: readonly WhopBillingStatus[] = [
  'active',
  'trialing',
  'canceling',
];

const whopLog = logger({ component: 'whop' });

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export interface WhopSignatureMeta {
  /** `webhook-id` header. */
  webhookId: string;
  /** `webhook-timestamp` header (unix seconds, as sent). */
  timestamp: string;
}

function constantTimeEqualBase64(a: string, b: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(a)) return false;
  const left = Buffer.from(a, 'base64');
  const right = Buffer.from(b, 'base64');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verify a `webhook-signature` header against the raw body.
 *
 * `meta` supplies the `webhook-id`/`webhook-timestamp` that Whop prefixes to
 * the signed string; omit it only when the signed content is the body alone.
 * The header may carry several space-separated `v<n>,<sig>` pairs — any `v1`
 * match is accepted, compared in constant time.
 */
export function verifyWhopSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  meta?: WhopSignatureMeta,
): boolean {
  if (header === null || header === '' || secret === '') return false;

  const signed =
    meta === undefined ? rawBody : `${meta.webhookId}.${meta.timestamp}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(signed, 'utf8').digest('base64');

  let matched = false;
  for (const part of header.split(' ')) {
    const comma = part.indexOf(',');
    if (comma === -1) continue;
    if (part.slice(0, comma) !== 'v1') continue;
    // No short-circuit: every candidate is compared so timing stays flat.
    if (constantTimeEqualBase64(part.slice(comma + 1), expected)) matched = true;
  }
  return matched;
}

export type WhopVerification = { ok: true } | { ok: false; reason: string };

/** Header-driven verification: presence, replay window, then signature. */
export function verifyWhopRequest(
  rawBody: string,
  headers: Headers,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): WhopVerification {
  const webhookId = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signature = headers.get('webhook-signature');

  const legacySignature = headers.get('x-whop-signature');
  const anyStandardHeader = webhookId !== null || timestamp !== null || signature !== null;
  if (!anyStandardHeader) {
    if (!legacySignature || secret === '') return { ok: false, reason: 'missing_signature_headers' };
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    let matched = false;
    for (const part of legacySignature.split(/\s+/)) {
      const comma = part.indexOf(',');
      const candidate = comma === -1 ? part : part.slice(comma + 1);
      // Compare every candidate to avoid making the first matching signature
      // observable through an early return.
      if (constantTimeEqualHex(candidate, expected)) matched = true;
    }
    return matched ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
  }

  if (!webhookId || !timestamp || !signature) {
    return { ok: false, reason: 'missing_signature_headers' };
  }

  const sentAt = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(sentAt)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(nowSeconds - sentAt) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_outside_tolerance' };
  }

  if (!verifyWhopSignature(rawBody, signature, secret, { webhookId, timestamp })) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

const jsonObject = z.record(z.string(), z.unknown());

/** Standard Webhooks envelope. `account_id` is `company_id` on pins < 2026-08-14. */
export const whopEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  api_version: z.string().nullish(),
  api_version_date: z.string().nullish(),
  timestamp: z.string().nullish(),
  account_id: z.string().nullish(),
  company_id: z.string().nullish(),
  data: jsonObject,
});
export type WhopEvent = z.infer<typeof whopEventSchema>;

/** ISO 8601 on v1; legacy pins send unix seconds. */
const timestampish = z.union([z.string(), z.number()]).nullish();

function toIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export const whopMembershipSchema = z.object({
  id: z.string().min(1),
  account: z.object({ id: z.string() }).nullish(),
  status: z.string().min(1),
  plan_id: z.string().nullish(),
  plan: z.object({ id: z.string().nullish() }).nullish(),
  product_id: z.string().nullish(),
  user_id: z.string().nullish(),
  user: z.object({ id: z.string().nullish(), email: z.string().nullish() }).nullish(),
  current_period_end: timestampish,
  renewal_period_end: timestampish,
  metadata: jsonObject.nullish(),
});
export type WhopMembershipPayload = z.infer<typeof whopMembershipSchema>;

export const whopPaymentSchema = z.object({
  id: z.string().min(1),
  status: z.string().nullish(),
  plan_id: z.string().nullish(),
  plan: z.object({ id: z.string().nullish() }).nullish(),
  membership_id: z.string().nullish(),
  membership: z.object({ id: z.string().nullish() }).nullish(),
  user_id: z.string().nullish(),
  user: z.object({ id: z.string().nullish(), email: z.string().nullish() }).nullish(),
  metadata: jsonObject.nullish(),
  billing_reason: z.string().nullish(),
});
export type WhopPaymentPayload = z.infer<typeof whopPaymentSchema>;

/** Normalized shape the rest of the codebase works with. */
export interface WhopMembership {
  id: string;
  planId: string;
  status: string;
  whopUserId: string | null;
  email: string | null;
  currentPeriodEnd: string | null;
  metadata: Record<string, unknown>;
}

/** `null` when the payload carries no plan id — nothing can be mapped from it. */
export function normalizeMembership(payload: WhopMembershipPayload): WhopMembership | null {
  const planId = payload.plan_id ?? payload.plan?.id ?? null;
  if (planId === null || planId === '') return null;
  return {
    id: payload.id,
    planId,
    status: payload.status,
    whopUserId: payload.user_id ?? payload.user?.id ?? null,
    email: payload.user?.email ?? null,
    currentPeriodEnd: toIso(payload.current_period_end ?? payload.renewal_period_end),
    metadata: payload.metadata ?? {},
  };
}

export type WhopEventKind =
  | 'membership_valid'
  | 'membership_invalid'
  | 'payment_failed'
  | 'payment_succeeded'
  | 'other';

/**
 * v1 event names, plus the legacy spellings older pins still send.
 * Whop has no dedicated renewal event: a renewal shows up as another valid
 * membership event (or as `payment.succeeded` for the subscription).
 */
const EVENT_KINDS: Record<string, WhopEventKind> = {
  'membership.activated': 'membership_valid',
  membership_went_valid: 'membership_valid',
  'membership.went_valid': 'membership_valid',
  'membership.deactivated': 'membership_invalid',
  membership_went_invalid: 'membership_invalid',
  'membership.went_invalid': 'membership_invalid',
  'payment.failed': 'payment_failed',
  payment_failed: 'payment_failed',
  'payment.succeeded': 'payment_succeeded',
  payment_succeeded: 'payment_succeeded',
};

export function classifyEvent(type: string): WhopEventKind {
  return EVENT_KINDS[type] ?? 'other';
}

// ---------------------------------------------------------------------------
// REST reads
// ---------------------------------------------------------------------------

export class WhopApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'WhopApiError';
  }
}

/** Authenticated GET against the Whop REST API. Callers parse the result. */
export async function whopFetch(path: string): Promise<unknown> {
  const apiKey = process.env.WHOP_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new WhopApiError('WHOP_API_KEY is not configured', 0);
  }

  const response = await fetch(`${WHOP_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'Api-Version-Date': '2026-09-15' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new WhopApiError(`GET ${path} failed: ${response.status}`, response.status);
  }
  return response.json();
}

const membershipPageSchema = z.object({
  data: z.array(whopMembershipSchema),
  page_info: z.object({
    end_cursor: z.string().nullable(),
    has_next_page: z.boolean(),
  }),
});

export interface MembershipPage {
  memberships: WhopMembership[];
  /** Skipped rows carried no plan id; counted so reconciliation can report them. */
  skipped: number;
  nextCursor: string | null;
}

/**
 * One page of the account's memberships in one billing status.
 *
 * Docs (List Memberships): the credential already scopes the result to its
 * account, and `account_id` (`biz_` tag) narrows it explicitly — we pass it
 * when configured so a multi-account key cannot leak other companies' rows.
 * `status` is one of active | trialing | past_due | completed | canceled |
 * expired | canceling | paused; paging is `first` + `after` with
 * `page_info.end_cursor`.
 */
export async function fetchMembershipPage(options: {
  status: WhopBillingStatus;
  after?: string | undefined;
}): Promise<MembershipPage> {
  const params = new URLSearchParams({
    status: options.status,
    first: String(MEMBERSHIP_PAGE_SIZE),
  });
  const accountId = process.env.WHOP_ACCOUNT_ID;
  if (accountId !== undefined && accountId !== '') params.set('account_id', accountId);
  if (options.after !== undefined) params.set('after', options.after);

  const page = membershipPageSchema.parse(await whopFetch(`/memberships?${params.toString()}`));
  const memberships: WhopMembership[] = [];
  let skipped = 0;
  for (const row of page.data) {
    const normalized = normalizeMembership(row);
    if (normalized === null) skipped += 1;
    else memberships.push(normalized);
  }
  return {
    memberships,
    skipped,
    nextCursor: page.page_info.has_next_page ? page.page_info.end_cursor : null,
  };
}

/** A single membership, re-read to get authoritative billing state. */
export async function fetchMembership(membershipId: string): Promise<WhopMembership | null> {
  const parsed = whopMembershipSchema.parse(await whopFetch(`/memberships/${encodeURIComponent(membershipId)}`));
  if (parsed.id !== membershipId || (parsed.account && parsed.account.id !== process.env.WHOP_ACCOUNT_ID)) {
    throw new Error('Membership account mismatch');
  }
  return normalizeMembership(parsed);
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/** Authenticated POST against the Whop REST API. */
export async function whopPost(path: string, body: unknown): Promise<unknown> {
  const apiKey = process.env.WHOP_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new WhopApiError('WHOP_API_KEY is not configured', 0);
  }

  const response = await fetch(`${WHOP_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'Api-Version-Date': '2026-09-15',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new WhopApiError(`POST ${path} failed: ${response.status}`, response.status);
  }
  return response.json();
}

export interface CheckoutSession {
  url: string;
  sessionId: string | null;
  planId?: string;
  carriesUserId: boolean;
}

/** Create a checkout for a configured recurring Whop plan. */
export async function createCheckoutSession(
  input: { planId: string; userId: string; returnUrl: string; purchaseId: string },
): Promise<CheckoutSession> {
  const { checkoutConfigured, checkoutResult } = await import('./purchases');
  if (!checkoutConfigured()) throw new Error('Billing is temporarily unavailable.');
  const planKey = planKeyFromWhopPlanId(input.planId);
  if (!planKey || planKey === 'free') throw new Error('Unknown subscription plan');
  const accountId = process.env.WHOP_ACCOUNT_ID;
  if (!accountId) throw new Error('WHOP_ACCOUNT_ID is not configured');

  const client = createWhopClient();
  const configuration = await client.checkoutConfigurations.create({
    account_id: accountId,
    plan_id: input.planId,
    redirect_url: input.returnUrl,
    metadata: {
      userId: input.userId,
      terms: '2026-09-21',
      creditTerms: '2026-09-22',
      purchaseId: input.purchaseId,
    },
  }, { idempotencyKey: input.purchaseId });
  return checkoutResult(configuration);
}

// ---------------------------------------------------------------------------
// User mapping
// ---------------------------------------------------------------------------

export interface UserLink {
  userId: string;
  via: 'metadata' | 'external_id' | 'email';
}

const uuid = z.uuid();

function metadataUserId(metadata: Record<string, unknown>): string | null {
  const candidate = metadata['userId'] ?? metadata['user_id'];
  if (typeof candidate !== 'string') return null;
  const parsed = uuid.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Map a Whop event to our user.
 *
 * Checkout attaches our user id as checkout-configuration metadata, which Whop
 * copies onto payments and memberships — that is the only authoritative link.
 * Failing that we accept an existing entitlement whose `external_id` is this
 * membership (our own earlier record), then an exact single email match, which
 * is logged loudly. Anything else is left unmapped rather than guessed.
 */
export async function resolveUser(
  service: SupabaseClient,
  input: {
    metadata: Record<string, unknown>;
    membershipId?: string | null;
    email?: string | null;
  },
  log: Logger = whopLog,
): Promise<UserLink | null> {
  const fromMetadata = metadataUserId(input.metadata);
  if (fromMetadata !== null) {
    const { data, error } = await service
      .from('profiles')
      .select('id')
      .eq('id', fromMetadata)
      .maybeSingle();
    if (error !== null) throw new Error(`whop: profile lookup failed: ${error.message}`);
    if (data !== null) return { userId: fromMetadata, via: 'metadata' };
    log.warn('whop.link.metadata_user_missing', { whop_metadata_user_id: fromMetadata });
  }

  if (input.membershipId !== undefined && input.membershipId !== null) {
    const { data, error } = await service
      .from('entitlements')
      .select('user_id')
      .eq('external_id', input.membershipId)
      .maybeSingle();
    if (error !== null) throw new Error(`whop: entitlement lookup failed: ${error.message}`);
    const linked = z.object({ user_id: z.uuid() }).safeParse(data);
    if (linked.success) return { userId: linked.data.user_id, via: 'external_id' };
  }

  if (input.email !== undefined && input.email !== null && input.email !== '') {
    const { data, error } = await service
      .from('profiles')
      .select('id')
      .eq('email', input.email)
      .limit(2);
    if (error !== null) throw new Error(`whop: profile email lookup failed: ${error.message}`);
    const rows = z.array(z.object({ id: z.uuid() })).parse(data ?? []);
    const only = rows.length === 1 ? rows[0] : undefined;
    if (only !== undefined) {
      log.warn('whop.link.email_fallback', {
        alert: true,
        email: input.email,
        user_id: only.id,
        detail: 'checkout metadata was absent; linked by unique email match',
      });
      return { userId: only.id, via: 'email' };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entitlement + ledger writes
// ---------------------------------------------------------------------------

const entitlementRowSchema = z.object({
  user_id: z.uuid(),
  plan_key: z.string(),
  status: z.string(),
  external_id: z.string().nullable(),
  current_period_end: z.string().nullable(),
  monthly_credits: z.coerce.number(),
});
export type EntitlementRow = z.infer<typeof entitlementRowSchema>;

const ENTITLEMENT_COLUMNS =
  'user_id, plan_key, status, external_id, current_period_end, monthly_credits';

export async function readEntitlement(
  service: SupabaseClient,
  userId: string,
): Promise<EntitlementRow | null> {
  const { data, error } = await service
    .from('entitlements')
    .select(ENTITLEMENT_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (error !== null) throw new Error(`whop: entitlement read failed: ${error.message}`);
  return data === null ? null : entitlementRowSchema.parse(data);
}

async function writeEntitlement(
  service: SupabaseClient,
  row: {
    user_id: string;
    plan_key: PlanKey;
    status: string;
    external_id: string | null;
    current_period_end: string | null;
    monthly_credits: number;
  },
): Promise<void> {
  const { error } = await service
    .from('entitlements')
    .upsert({ ...row, provider: 'whop', updated_at: new Date().toISOString() }, {
      onConflict: 'user_id',
    });
  if (error !== null) throw new Error(`whop: entitlement write failed: ${error.message}`);
}

/**
 * Whop billing status → our entitlement status. `completed` covers one-time
 * purchases that keep access; `canceling` is still active until the period
 * ends; `past_due` is the post-failure grace period. `paused` (payment
 * collection suspended) and the terminal states drop to inactive.
 */
function entitlementStatus(membershipStatus: string): string {
  switch (membershipStatus) {
    case 'active':
    case 'trialing':
    case 'completed':
    case 'canceling':
      return 'active';
    case 'past_due':
      return 'past_due';
    default:
      return 'inactive';
  }
}

export type MembershipIntent = 'valid' | 'invalid';

export interface ApplyMembershipResult {
  outcome: 'applied' | 'unknown_plan' | 'unmapped_user';
  userId: string | null;
  planKey: PlanKey | null;
  status: string | null;
  grantedCredits: number;
}

export interface ApplyMembershipOptions {
  /** Which event delivered this membership; drives the plan_key/history rule. */
  intent?: MembershipIntent;
  log?: Logger;
}

/** Membership events update access; only verified payment.succeeded receipts grant credits. */
export async function applyMembership(
  service: SupabaseClient,
  payload: WhopMembership,
  options: ApplyMembershipOptions = {},
): Promise<ApplyMembershipResult> {
  const log = options.log ?? whopLog;
  const intent: MembershipIntent = options.intent ?? 'valid';

  const planKey = planKeyFromWhopPlanId(payload.planId);
  if (planKey === null) {
    log.warn('whop.membership.unknown_plan', {
      whop_plan_id: payload.planId,
      membership_id: payload.id,
      detail: 'plan id maps to no internal plan; entitlement left untouched',
    });
    return { outcome: 'unknown_plan', userId: null, planKey: null, status: null, grantedCredits: 0 };
  }

  const link = await resolveUser(
    service,
    { metadata: payload.metadata, membershipId: payload.id, email: payload.email },
    log,
  );
  if (link === null) {
    log.error('whop.membership.unmapped_user', {
      alert: true,
      membership_id: payload.id,
      whop_user_id: payload.whopUserId,
      detail: 'no checkout metadata user id and no unique email match; event stored only',
    });
    return {
      outcome: 'unmapped_user',
      userId: null,
      planKey,
      status: null,
      grantedCredits: 0,
    };
  }

  const existing = await readEntitlement(service, link.userId);
  const status = intent === 'invalid' ? 'inactive' : entitlementStatus(payload.status);
  const plan = getPlans()[planKey];

  // An invalid membership keeps its plan_key (and allotment) for history.
  const storedPlanKey =
    intent === 'invalid' && existing !== null && isPlanKey(existing.plan_key)
      ? existing.plan_key
      : planKey;
  const monthlyCredits =
    intent === 'invalid' && existing !== null ? existing.monthly_credits : plan.monthlyCredits;

  const grantedCredits = 0;
  const periodEnd = payload.currentPeriodEnd;
  const storedPeriodEnd = existing?.current_period_end ?? null;
  // Never roll access backwards when an older delivery arrives late.
  if (periodEnd && storedPeriodEnd && Date.parse(periodEnd) < Date.parse(storedPeriodEnd)) {
    return { outcome: 'applied', userId: link.userId, planKey, status: existing!.status, grantedCredits };
  }
  if (existing?.external_id && existing.external_id !== payload.id && intent === 'invalid') {
    return { outcome: 'applied', userId: link.userId, planKey, status: existing.status, grantedCredits };
  }

  await writeEntitlement(service, {
    user_id: link.userId,
    plan_key: storedPlanKey,
    status,
    external_id: payload.id,
    current_period_end: intent === 'invalid' ? storedPeriodEnd : (periodEnd ?? storedPeriodEnd),
    monthly_credits: monthlyCredits,
  });

  log.info('whop.entitlement.applied', {
    user_id: link.userId,
    linked_via: link.via,
    plan_key: storedPlanKey,
    status,
    membership_id: payload.id,
  });

  return { outcome: 'applied', userId: link.userId, planKey, status, grantedCredits };
}

export interface ApplyPaymentResult {
  outcome: 'applied' | 'ignored' | 'unmapped_user';
  userId: string | null;
  grantedCredits: number;
  detail?: string;
}

/** A failed subscription payment puts the entitlement in its grace state. */
export async function applyPaymentFailed(
  service: SupabaseClient,
  payment: WhopPaymentPayload,
  options: { log?: Logger } = {},
): Promise<ApplyPaymentResult> {
  const log = options.log ?? whopLog;
  const membershipId = payment.membership_id ?? payment.membership?.id ?? null;
  const planId = payment.plan_id ?? payment.plan?.id ?? null;

  const link = await resolveUser(
    service,
    { metadata: payment.metadata ?? {}, membershipId, email: payment.user?.email ?? null },
    log,
  );
  if (link === null) {
    log.error('whop.payment_failed.unmapped_user', {
      alert: true,
      payment_id: payment.id,
      detail: 'no checkout metadata user id and no unique email match; event stored only',
    });
    return { outcome: 'unmapped_user', userId: null, grantedCredits: 0 };
  }

  const existing = await readEntitlement(service, link.userId);
  const mappedPlan = planId === null ? null : planKeyFromWhopPlanId(planId);
  if (!mappedPlan || (existing?.external_id && membershipId !== existing.external_id)) {
    return { outcome: 'ignored', userId: link.userId, grantedCredits: 0, detail: 'unrelated_membership' };
  }
  const planKey: PlanKey =
    existing !== null && isPlanKey(existing.plan_key)
      ? existing.plan_key
      : (mappedPlan ?? 'free');

  await writeEntitlement(service, {
    user_id: link.userId,
    plan_key: planKey,
    status: 'past_due',
    external_id: membershipId ?? existing?.external_id ?? null,
    current_period_end: existing?.current_period_end ?? null,
    monthly_credits: existing?.monthly_credits ?? 0,
  });

  log.warn('whop.payment_failed', {
    user_id: link.userId,
    payment_id: payment.id,
    membership_id: membershipId,
    plan_key: planKey,
  });
  return { outcome: 'applied', userId: link.userId, grantedCredits: 0 };
}

/** Plan ids this app sells — used to ignore other products of the account. */
export function ourPlanIds(): Set<string> {
  const ids = new Set<string>();
  const plans = getPlans();
  for (const key of Object.keys(plans) as PlanKey[]) {
    const id = plans[key].whopPlanId;
    if (id !== null && id !== '') ids.add(id);
  }
  return ids;
}

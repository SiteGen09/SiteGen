import type { Sql, TransactionSql } from 'postgres';

import { routingProviderIdentity, publicRoutingProviderIdentityFromIdentity } from '@/lib/ai/routing-provider';
import { getPlans, isPlanKey, type PlanKey } from '@/lib/billing/plans';
import { sendAdminEmail, type AdminEmail } from '@/lib/email/admin';
import type { Logger } from '@/lib/log';

import {
  upstreamAlertNotice,
  consumerPrice,
  keyExpiringNotice,
  keyQuotaNotice,
  lowBalanceNotice,
  modelsAddedNotice,
  modelsRemovedNotice,
  priceChanged,
  priceChangeNotice,
  type ConsumerPrice,
  type Draft,
  type ModelChange,
  type PriceChangeLine,
} from './messages';
import type { NotificationKind } from './types';

/**
 * Finds platform events worth telling consumers about and records them as
 * notifications. Runs every few minutes in the server process (see
 * scheduler.ts). Each check runs in its own transaction under a shared
 * advisory lock, so a second process skips rather than duplicates, and one
 * failing check does not hold back the others.
 *
 * The first run of each check only records a baseline: turning notifications
 * on must not announce every existing model or every user's existing balance.
 */

/** A model must stay unreachable this long before its removal is announced. */
const REMOVAL_GRACE_MS = 30 * 60_000;
/** Price history younger than this is left for the next run, so a burst of edits reads as one change. */
const PRICE_SETTLE = '10 minutes';
/** $1 at one credit per $0.0001. The alert re-arms once the balance is back above twice this. */
export const LOW_BALANCE_CREDITS = 10_000;
const KEY_EXPIRY_WARNING = '3 days';
/** Upstream health: alert when at least this many attempts fail, and this share of them, in the window. */
export const UPSTREAM_WINDOW_MINUTES = 10;
export const UPSTREAM_MIN_FAILURES = 5;
export const UPSTREAM_FAILURE_RATE = 0.2;

type Tx = TransactionSql;

interface NotificationInput extends Draft {
  kind: NotificationKind;
  userId?: string | null;
  dedupeKey?: string | null;
}

/** Records a notification; false when its dedupe key says it was already sent. */
async function notify(tx: Tx, input: NotificationInput): Promise<boolean> {
  const inserted = await tx`
    INSERT INTO notifications (kind, user_id, title, body, link, important, dedupe_key)
    VALUES (${input.kind}, ${input.userId ?? null}, ${input.title}, ${input.body}, ${input.link},
      ${input.important}, ${input.dedupeKey ?? null})
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id`;
  return inserted.length > 0;
}

/** Email a check wants sent once its transaction has committed. */
interface Outbox {
  outbox?: AdminEmail[];
}

function siteUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://gensite.tech').replace(/\/+$/, '');
  return `${base}${path}`;
}

async function cursor(tx: Tx, name: string): Promise<bigint | null> {
  const [row] = await tx<{ value: string }[]>`SELECT value::text FROM notification_cursors WHERE name = ${name}`;
  return row ? BigInt(row.value) : null;
}

async function setCursor(tx: Tx, name: string, value: bigint | number): Promise<void> {
  await tx`
    INSERT INTO notification_cursors (name, value) VALUES (${name}, ${value.toString()})
    ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

function rankOf(plan: string): number {
  return isPlanKey(plan) ? getPlans()[plan].rank : 0;
}

/** Models a consumer can reach now, with the lowest plan that reaches each. */
async function servableModels(tx: Tx): Promise<Map<string, { modality: string; minPlan: PlanKey }>> {
  const rows = await tx<{ public_model_id: string; modality: string; channel_plan: string; source_plan: string }[]>`
    SELECT c.public_model_id, s.modality, c.min_plan AS channel_plan, s.min_plan AS source_plan
    FROM channels c JOIN sources s ON s.id = c.source_id
    WHERE c.public_model_id IS NOT NULL AND NOT c.is_byok AND c.status <> 'off' AND s.status <> 'off'
      AND (c.pricing_type = 'token' OR c.request_price_usd IS NOT NULL)`;
  const plans = getPlans();
  const byRank = Object.values(plans).sort((a, b) => a.rank - b.rank);
  const result = new Map<string, { modality: string; minPlan: PlanKey }>();
  for (const row of rows) {
    const rank = Math.max(rankOf(row.channel_plan), rankOf(row.source_plan));
    const plan = byRank.find((candidate) => candidate.rank >= rank)?.key ?? 'free';
    const known = result.get(row.public_model_id);
    if (!known || plans[plan].rank < plans[known.minPlan].rank) result.set(row.public_model_id, { modality: row.modality, minPlan: plan });
  }
  return result;
}

export async function scanModels(tx: Tx, now: Date): Promise<{ added: number; removed: number }> {
  const current = await servableModels(tx);
  if ((await cursor(tx, 'models_seeded')) === null) {
    for (const [model, { modality }] of current) {
      await tx`INSERT INTO notification_model_catalog (public_model_id, modality) VALUES (${model}, ${modality})
        ON CONFLICT DO NOTHING`;
    }
    await setCursor(tx, 'models_seeded', 1);
    return { added: 0, removed: 0 };
  }
  const known = await tx<{ public_model_id: string; modality: string; missing_since: Date | null }[]>`
    SELECT public_model_id, modality, missing_since FROM notification_model_catalog FOR UPDATE`;
  const knownIds = new Set(known.map((row) => row.public_model_id));
  const plans = getPlans();
  const describe = (model: string, modality: string, minPlan: PlanKey): ModelChange => ({
    model, modality, planLabel: minPlan === 'free' ? null : plans[minPlan].label,
  });

  const added: ModelChange[] = [];
  for (const [model, { modality, minPlan }] of current) {
    if (knownIds.has(model)) continue;
    await tx`INSERT INTO notification_model_catalog (public_model_id, modality) VALUES (${model}, ${modality})`;
    added.push(describe(model, modality, minPlan));
  }
  const removed: ModelChange[] = [];
  for (const row of known) {
    if (current.has(row.public_model_id)) {
      if (row.missing_since) await tx`UPDATE notification_model_catalog SET missing_since = NULL WHERE public_model_id = ${row.public_model_id}`;
      continue;
    }
    if (!row.missing_since) {
      await tx`UPDATE notification_model_catalog SET missing_since = ${now} WHERE public_model_id = ${row.public_model_id}`;
    } else if (now.getTime() - row.missing_since.getTime() >= REMOVAL_GRACE_MS) {
      await tx`DELETE FROM notification_model_catalog WHERE public_model_id = ${row.public_model_id}`;
      removed.push(describe(row.public_model_id, row.modality, 'free'));
    }
  }
  if (added.length) await notify(tx, { kind: 'model_added', ...modelsAddedNotice(added) });
  if (removed.length) await notify(tx, { kind: 'model_removed', ...modelsRemovedNotice(removed) });
  return { added: added.length, removed: removed.length };
}

interface HistoryRow {
  id: string;
  action: 'source.update' | 'channel.update';
  target: string;
  before: unknown;
  after: unknown;
}

function multiplierOf(snapshot: unknown): number | null {
  const value = typeof snapshot === 'object' && snapshot !== null ? (snapshot as Record<string, unknown>).credit_multiplier : null;
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function scanPrices(tx: Tx): Promise<{ changed: number }> {
  const last = await cursor(tx, 'price_history');
  if (last === null) {
    const [row] = await tx<{ max: string | null }[]>`SELECT max(id)::text AS max FROM routing_price_history`;
    await setCursor(tx, 'price_history', BigInt(row?.max ?? '0'));
    return { changed: 0 };
  }
  const history = await tx<HistoryRow[]>`
    SELECT id::text, action, target, before, after FROM routing_price_history
    WHERE id > ${last.toString()} AND created_at < now() - ${PRICE_SETTLE}::interval
    ORDER BY id`;
  if (!history.length) return { changed: 0 };

  // Earliest "before" and latest "after" per channel and per source: a burst
  // of edits nets out to one change, and an edit that was undone to none.
  const channelBefore = new Map<string, unknown>();
  const channelAfter = new Map<string, unknown>();
  const sourceBefore = new Map<string, number | null>();
  const sourceAfter = new Map<string, number | null>();
  for (const row of history) {
    const id = row.target.replace(/^(channel|source):/, '');
    if (row.action === 'channel.update') {
      if (!channelBefore.has(id)) channelBefore.set(id, row.before);
      channelAfter.set(id, row.after);
    } else {
      if (!sourceBefore.has(id)) sourceBefore.set(id, multiplierOf(row.before));
      sourceAfter.set(id, multiplierOf(row.after));
    }
  }

  const channels = await tx<{
    id: string; public_model_id: string; provider: string; base_url: string | null; source_id: string;
    source_label: string; credit_multiplier: string; pricing_type: string; request_price_usd: string | null;
    input_per_mtok: string; output_per_mtok: string; billing_policy: unknown;
  }[]>`
    SELECT c.id, c.public_model_id, c.provider, c.base_url, c.source_id, s.label AS source_label,
      s.credit_multiplier::text, c.pricing_type, c.request_price_usd::text, c.input_per_mtok::text,
      c.output_per_mtok::text, c.billing_policy
    FROM channels c JOIN sources s ON s.id = c.source_id
    WHERE c.public_model_id IS NOT NULL AND NOT c.is_byok AND c.status <> 'off' AND s.status <> 'off'
      AND (c.id = ANY(${[...channelAfter.keys()]}::text[]) OR c.source_id = ANY(${[...sourceAfter.keys()]}::text[]))`;
  const names = new Map((await tx<{ id: string; label: string }[]>`
    SELECT id, label FROM routing_providers WHERE label IS NOT NULL`).map((row) => [row.id, row.label]));

  const changes: PriceChangeLine[] = [];
  for (const channel of channels) {
    const multiplier = Number(channel.credit_multiplier);
    const beforeMultiplier = sourceBefore.get(channel.source_id) ?? multiplier;
    const afterMultiplier = sourceAfter.get(channel.source_id) ?? multiplier;
    const before: ConsumerPrice | null = consumerPrice(channelBefore.get(channel.id) ?? channel, beforeMultiplier);
    const after: ConsumerPrice | null = consumerPrice(channelAfter.get(channel.id) ?? channel, afterMultiplier);
    if (!before || !after || !priceChanged(before, after)) continue;
    const provider = publicRoutingProviderIdentityFromIdentity(
      routingProviderIdentity({ baseUrl: channel.base_url, provider: channel.provider, sourceId: channel.source_id, sourceLabel: channel.source_label }),
      names,
    ).label;
    changes.push({ model: channel.public_model_id, provider, before, after });
  }
  changes.sort((a, b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider));
  if (changes.length) await notify(tx, { kind: 'price_change', ...priceChangeNotice(changes) });
  await setCursor(tx, 'price_history', BigInt(history[history.length - 1]!.id));
  return { changed: changes.length };
}

export async function scanBalances(tx: Tx): Promise<{ alerted: number }> {
  const rows = await tx<{ id: string; balance: string; notified: boolean | null; has_state: boolean }[]>`
    SELECT p.id, COALESCE(b.balance, 0)::text AS balance, s.low_balance_notified AS notified, s.user_id IS NOT NULL AS has_state
    FROM profiles p
    LEFT JOIN (SELECT user_id, sum(credits) AS balance FROM ledger GROUP BY user_id) b ON b.user_id = p.id
    LEFT JOIN notification_user_state s ON s.user_id = p.id`;
  let alerted = 0;
  for (const row of rows) {
    const balance = Number(row.balance);
    const low = balance < LOW_BALANCE_CREDITS;
    let next = row.notified;
    if (row.notified === null) next = low;
    else if (!row.notified && low) {
      await notify(tx, { kind: 'low_balance', userId: row.id, ...lowBalanceNotice(balance) });
      alerted += 1;
      next = true;
    } else if (row.notified && balance >= LOW_BALANCE_CREDITS * 2) next = false;
    if (next === row.notified) continue;
    await tx`
      INSERT INTO notification_user_state (user_id, low_balance_notified) VALUES (${row.id}, ${next})
      ON CONFLICT (user_id) DO UPDATE SET low_balance_notified = EXCLUDED.low_balance_notified`;
  }
  return { alerted };
}

export async function scanKeys(tx: Tx): Promise<{ expiring: number; quota: number }> {
  const expiring = await tx<{ id: string; owner_id: string; name: string; expires_at: Date }[]>`
    SELECT id, owner_id, name, expires_at FROM api_keys
    WHERE status = 'active' AND expires_at > now() AND expires_at <= now() + ${KEY_EXPIRY_WARNING}::interval`;
  for (const key of expiring) {
    await notify(tx, {
      kind: 'key_expiring', userId: key.owner_id, dedupeKey: `key_expiring:${key.id}:${key.expires_at.toISOString()}`,
      ...keyExpiringNotice(key.name, key.expires_at),
    });
  }
  const quota = await tx<{ id: string; owner_id: string; name: string; quota_credits: string; used_credits: string }[]>`
    SELECT id, owner_id, name, quota_credits::text, used_credits::text FROM api_keys
    WHERE status = 'active' AND quota_credits > 0 AND used_credits >= quota_credits * 0.8`;
  for (const key of quota) {
    const used = Number(key.used_credits);
    const limit = Number(key.quota_credits);
    const exhausted = used >= limit;
    await notify(tx, {
      kind: 'key_quota', userId: key.owner_id, dedupeKey: `key_quota:${key.id}:${limit}:${exhausted ? 100 : 80}`,
      ...keyQuotaNotice(key.name, used, limit, exhausted),
    });
  }
  return { expiring: expiring.length, quota: quota.length };
}

/**
 * Alerts administrators when an upstream provider fails often, per provider
 * and model family (the unit a Relay source switch acts on). Failed attempts
 * come from upstream_attempt_failures, which also sees failures that fallback
 * rescued; successes are the requests a channel finally served.
 */
export async function scanUpstreamHealth(tx: Tx, now: Date): Promise<{ alerted: number } & Outbox> {
  await tx`DELETE FROM upstream_attempt_failures WHERE created_at < now() - interval '7 days'`;
  const window = `${UPSTREAM_WINDOW_MINUTES} minutes`;
  const rows = await tx<{ id: string; base_url: string | null; provider: string; source_id: string; source_label: string; family: string; failed: number; succeeded: number; errors: string[] }[]>`
    WITH failed AS (
      SELECT channel_id, count(*)::int AS n, array_agg(error_code) AS errors FROM upstream_attempt_failures
      WHERE created_at > now() - ${window}::interval GROUP BY channel_id
    ), served AS (
      SELECT channel_id, count(*)::int AS n FROM usage_events
      WHERE status = 'ok' AND channel_id IS NOT NULL AND created_at > now() - ${window}::interval GROUP BY channel_id
    )
    SELECT c.id, c.base_url, c.provider, c.source_id, s.label AS source_label, s.family,
      COALESCE(f.n, 0) AS failed, COALESCE(v.n, 0) AS succeeded, COALESCE(f.errors, '{}') AS errors
    FROM channels c JOIN sources s ON s.id = c.source_id
    LEFT JOIN failed f ON f.channel_id = c.id LEFT JOIN served v ON v.channel_id = c.id
    WHERE f.n > 0 AND NOT c.is_byok`;
  const groups = new Map<string, { provider: string; family: string; failed: number; succeeded: number; errors: string[] }>();
  for (const row of rows) {
    const provider = routingProviderIdentity({ baseUrl: row.base_url, provider: row.provider, sourceId: row.source_id, sourceLabel: row.source_label });
    const key = `${provider.id}:${row.family}`;
    const group = groups.get(key) ?? { provider: provider.label, family: row.family, failed: 0, succeeded: 0, errors: [] };
    group.failed += row.failed;
    group.succeeded += row.succeeded;
    group.errors.push(...row.errors);
    groups.set(key, group);
  }
  const admins = await tx<{ id: string }[]>`SELECT id FROM profiles WHERE role = 'admin'`;
  const hour = now.toISOString().slice(0, 13);
  let alerted = 0;
  const outbox: AdminEmail[] = [];
  for (const [key, group] of groups) {
    if (group.failed < UPSTREAM_MIN_FAILURES || group.failed / (group.failed + group.succeeded) < UPSTREAM_FAILURE_RATE) continue;
    const counts = new Map<string, number>();
    for (const code of group.errors) counts.set(code, (counts.get(code) ?? 0) + 1);
    const topErrors = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([code, n]) => `${code} (${n})`);
    const draft = upstreamAlertNotice({ ...group, windowMinutes: UPSTREAM_WINDOW_MINUTES, topErrors });
    let fresh = false;
    for (const admin of admins) {
      fresh = (await notify(tx, { kind: 'upstream_alert', userId: admin.id, dedupeKey: `upstream_alert:${key}:${hour}:${admin.id}`, ...draft })) || fresh;
    }
    // Same hourly limit as the dashboard alert: one email per provider and family.
    if (fresh) outbox.push({ subject: `[gensite] ${draft.title}`, text: `${draft.body}\n\n${siteUrl(draft.link)}` });
    alerted += 1;
  }
  return { alerted, outbox };
}

const CHECKS = { models: scanModels, prices: scanPrices, balances: scanBalances, keys: scanKeys, upstream: scanUpstreamHealth } as const;

/** One pass of every check. Returns what each found, or its error. */
export async function runNotificationScan(
  sql: Sql,
  log: Logger,
  now = new Date(),
  send: (email: AdminEmail) => Promise<boolean> = sendAdminEmail,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const [name, check] of Object.entries(CHECKS)) {
    try {
      const result = await sql.begin(async (tx) => {
        const [lock] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('notification-scan')) AS locked`;
        if (!lock?.locked) return 'skipped: another scan is running';
        return (check as (tx: Tx, now: Date) => Promise<unknown>)(tx, now);
      });
      // Mail only after commit, so a rolled-back check never emails.
      const { outbox, ...summary } = typeof result === 'object' && result !== null ? result as Outbox : { outbox: undefined };
      results[name] = typeof result === 'object' && result !== null ? summary : result;
      for (const email of outbox ?? []) {
        const sent = await send(email);
        log[sent ? 'info' : 'warn'](sent ? 'notifications.email_sent' : 'notifications.email_not_sent', { check: name, subject: email.subject });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results[name] = { error: message };
      log.error('notifications.scan_failed', { check: name, error: message });
    }
  }
  return results;
}

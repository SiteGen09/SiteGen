import { pgTable, boolean, check, primaryKey, uniqueIndex, uuid, text, timestamp, bigserial, integer, numeric, jsonb, bigint, index, customType, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
});

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(), // references auth.users(id) via trigger
  email: text('email').notNull(),
  role: text('role').notNull().default('developer'), // developer | admin
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  lastFour: text('last_four').notNull(),
  scopes: text('scopes').array().notNull().default(['generate', 'chat']),
  status: text('status').notNull().default('active'), // active | revoked
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  rateLimitRpm: integer('rate_limit_rpm').notNull().default(60),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  ownerIdx: index('api_keys_owner_id_idx').on(table.ownerId),
  hashIdx: index('api_keys_key_hash_idx').on(table.keyHash),
}));

// Source metadata is independent of wire protocol: a compatible gateway can
// serve several families. Keep that fact in one place, on the source.
export const sources = pgTable('sources', {
  id: text('id').primaryKey(),
  family: text('family').notNull(),
  label: text('label').notNull(),
  description: text('description').notNull().default(''),
  creditMultiplier: numeric('credit_multiplier', { precision: 10, scale: 2 }).notNull(),
  status: text('status').notNull().default('active'),
  minPlan: text('min_plan').notNull().default('free'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  defaultFamily: uniqueIndex('sources_default_family_key').on(table.family).where(sql`${table.isDefault}`),
  familyCheck: check('sources_family_check', sql`${table.family} IN ('gpt', 'claude', 'grok')`),
  multiplierCheck: check('sources_credit_multiplier_check', sql`${table.creditMultiplier} > 0`),
  statusCheck: check('sources_status_check', sql`${table.status} IN ('active', 'degraded', 'off')`),
  planCheck: check('sources_min_plan_check', sql`${table.minPlan} IN ('free', 'starter', 'pro')`),
}));

export const userRoutingPreferences = pgTable('user_routing_preferences', {
  userId: uuid('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  family: text('family').notNull(),
  sourceId: text('source_id').notNull().references(() => sources.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.family] }),
  familyCheck: check('user_routing_preferences_family_check', sql`${table.family} IN ('gpt', 'claude', 'grok')`),
}));

export const channels = pgTable('channels', {
  id: text('id').primaryKey(), // slug, e.g. 'spec-strong'
  label: text('label').notNull(),
  task: text('task').notNull(), // site.spec | site.copy | interview
  provider: text('provider').notNull(), // see lib/ai/providers.ts PROVIDERS
  baseUrl: text('base_url'),
  modelId: text('model_id').notNull(),
  sourceId: text('source_id').references(() => sources.id),
  publicModelId: text('public_model_id'),
  vendor: text('vendor'),
  contextWindow: integer('context_window'),
  endpoints: text('endpoints').array().notNull().default([]),
  tags: text('tags').array().notNull().default([]),
  pricingType: text('pricing_type').notNull().default('token'),
  listInputPerMTok: numeric('list_input_per_mtok', { precision: 12, scale: 6 }),
  listOutputPerMTok: numeric('list_output_per_mtok', { precision: 12, scale: 6 }),
  listCachedPerMTok: numeric('list_cached_per_mtok', { precision: 12, scale: 6 }),
  inputPerMTok: numeric('input_per_mtok', { precision: 12, scale: 6 }).notNull(),
  outputPerMTok: numeric('output_per_mtok', { precision: 12, scale: 6 }).notNull(),
  cachedPerMTok: numeric('cached_per_mtok', { precision: 12, scale: 6 }).notNull(),
  isByok: boolean('is_byok').notNull().default(false),
  creditMultiplier: numeric('credit_multiplier', { precision: 10, scale: 2 }).notNull().default('1.0'),
  status: text('status').notNull().default('active'), // active | degraded | off
  minPlan: text('min_plan').notNull().default('free'),
  fallbackTo: text('fallback_to').references((): AnyPgColumn => channels.id),
  priority: integer('priority').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  byokIdx: index('channels_is_byok_idx').on(table.isByok),
  ratesCheck: check('channels_rates_nonnegative', sql.raw('input_per_mtok >= 0 AND output_per_mtok >= 0 AND cached_per_mtok >= 0')),
  contextCheck: check('channels_context_window_check', sql.raw('context_window > 0')),
  pricingTypeCheck: check('channels_pricing_type_check', sql.raw("pricing_type IN ('token','request')")),
  listInputCheck: check('channels_list_input_per_mtok_check', sql.raw('list_input_per_mtok >= 0')),
  listOutputCheck: check('channels_list_output_per_mtok_check', sql.raw('list_output_per_mtok >= 0')),
  listCachedCheck: check('channels_list_cached_per_mtok_check', sql.raw('list_cached_per_mtok >= 0')),
  sourceIdx: index('channels_source_id_idx').on(table.sourceId),
  publicModelIdx: index('channels_public_model_id_idx').on(table.publicModelId).where(sql`${table.publicModelId} IS NOT NULL`),
  sourceCheck: check('channels_source_check', sql`(${table.isByok} AND ${table.sourceId} IS NULL) OR (NOT ${table.isByok} AND ${table.sourceId} IS NOT NULL)`),
}));

export const providerCredentials = pgTable('provider_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').references(() => profiles.id, { onDelete: 'cascade' }), // null = platform key
  provider: text('provider').notNull(),
  baseUrl: text('base_url'),
  ciphertext: bytea('ciphertext').notNull(), // AES-256-GCM
  iv: bytea('iv').notNull(),
  authTag: bytea('auth_tag').notNull(),
  lastFour: text('last_four').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerIdx: index('provider_credentials_owner_id_idx').on(table.ownerId),
}));

export const entitlements = pgTable('entitlements', {
  userId: uuid('user_id').primaryKey().references(() => profiles.id, { onDelete: 'cascade' }),
  planKey: text('plan_key').notNull().default('free'),
  status: text('status').notNull().default('inactive'),
  provider: text('provider').notNull().default('whop'),
  externalId: text('external_id'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  monthlyCredits: bigint('monthly_credits', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ledger = pgTable('ledger', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  requestId: text('request_id').notNull().unique(),
  kind: text('kind').notNull(), // topup | grant | hold | settle | release | refund
  credits: bigint('credits', { mode: 'number' }).notNull(), // signed
  channelId: text('channel_id').references(() => channels.id),
  meta: jsonb('meta'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdx: index('ledger_user_id_idx').on(table.userId),
  requestIdx: index('ledger_request_id_idx').on(table.requestId),
}));

export const usageEvents = pgTable('usage_events', {
  requestId: text('request_id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id),
  channelId: text('channel_id').references(() => channels.id),
  // Historical snapshots survive a source rename, reassignment or retirement.
  sourceId: text('source_id'),
  sourceLabel: text('source_label'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cachedTokens: integer('cached_tokens'),
  latencyMs: integer('latency_ms'),
  status: text('status').notNull(), // ok | failed | rejected
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
  creditsCharged: bigint('credits_charged', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdx: index('usage_events_user_id_idx').on(table.userId),
}));

export const billingEvents = pgTable('billing_events', {
  eventId: text('event_id').primaryKey(),
  provider: text('provider').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adminAuditLog = pgTable('admin_audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: uuid('actor_id').notNull().references(() => profiles.id),
  action: text('action').notNull(),
  target: text('target').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  actorIdx: index('admin_audit_log_actor_id_idx').on(table.actorId),
}));

// Relations
export const profilesRelations = relations(profiles, ({ many }) => ({
  apiKeys: many(apiKeys),
  providerCredentials: many(providerCredentials),
  ledgerEntries: many(ledger),
  usageEvents: many(usageEvents),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  owner: one(profiles, {
    fields: [apiKeys.ownerId],
    references: [profiles.id],
  }),
}));

export const ledgerRelations = relations(ledger, ({ one }) => ({
  user: one(profiles, {
    fields: [ledger.userId],
    references: [profiles.id],
  }),
  channel: one(channels, {
    fields: [ledger.channelId],
    references: [channels.id],
  }),
}));

// Probes are service-only, just like usage aggregation; RLS lives in the DDL.
export const modelHealthChecks = pgTable('model_health_checks', {
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  bucketHour: timestamp('bucket_hour', { withTimezone: true }).notNull(),
  status: text('status').notNull(),
  latencyMs: integer('latency_ms'),
  errorDetail: text('error_detail'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  channelHour: uniqueIndex('model_health_checks_channel_hour_key').on(table.channelId, table.bucketHour),
  hourIdx: index('model_health_checks_hour_idx').on(table.bucketHour),
  statusCheck: check('model_health_checks_status_check', sql.raw("status IN ('ok', 'error', 'timeout')")),
  latencyCheck: check('model_health_checks_latency_ms_check', sql.raw('latency_ms >= 0')),
}));

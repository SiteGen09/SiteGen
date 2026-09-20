import { pgTable, boolean, check, uuid, text, timestamp, bigserial, integer, numeric, jsonb, bigint, index, customType, type AnyPgColumn } from 'drizzle-orm/pg-core';
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

export const channels = pgTable('channels', {
  id: text('id').primaryKey(), // slug, e.g. 'spec-strong'
  label: text('label').notNull(),
  task: text('task').notNull(), // site.spec | site.copy | interview
  provider: text('provider').notNull(), // see lib/ai/providers.ts PROVIDERS
  baseUrl: text('base_url'),
  modelId: text('model_id').notNull(),
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
  byokMultiplierCheck: check('channels_byok_multiplier_check', sql`NOT ${table.isByok} OR ${table.creditMultiplier} = 0`),
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
  channelId: text('channel_id').notNull().references(() => channels.id),
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

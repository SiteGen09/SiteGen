-- Initial schema: all tables, RLS policies, grants, and signup trigger.
-- Convention: every table has RLS enabled. Tables with no policies are
-- inaccessible to clients entirely (server/service-role only).

-- ============================================================
-- Tables
-- ============================================================

CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	"email" text NOT NULL,
	"role" text DEFAULT 'developer' NOT NULL CHECK (role IN ('developer', 'admin')),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"key_hash" text NOT NULL UNIQUE,
	"key_prefix" text NOT NULL,
	"last_four" text NOT NULL,
	"scopes" text[] DEFAULT '{"generate"}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'revoked')),
	"last_used_at" timestamp with time zone,
	"rate_limit_rpm" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);

CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"task" text NOT NULL CHECK (task IN ('site.spec', 'site.copy', 'interview')),
	"provider" text NOT NULL CHECK (provider IN ('anthropic', 'openai_compatible')),
	"base_url" text,
	"model_id" text NOT NULL,
	"credit_multiplier" numeric(10, 2) DEFAULT '1.0' NOT NULL CHECK (credit_multiplier >= 0),
	"status" text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'degraded', 'off')),
	"min_plan" text DEFAULT 'free' NOT NULL,
	"fallback_to" text REFERENCES "channels"("id"),
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid REFERENCES "profiles"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"base_url" text,
	"ciphertext" bytea NOT NULL,
	"iv" bytea NOT NULL,
	"auth_tag" bytea NOT NULL,
	"last_four" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'revoked')),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "entitlements" (
	"user_id" uuid PRIMARY KEY NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
	"plan_key" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"provider" text DEFAULT 'whop' NOT NULL,
	"external_id" text,
	"current_period_end" timestamp with time zone,
	"monthly_credits" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
	"request_id" text NOT NULL UNIQUE,
	"kind" text NOT NULL CHECK (kind IN ('topup', 'grant', 'hold', 'settle', 'release', 'refund')),
	"credits" bigint NOT NULL,
	"channel_id" text REFERENCES "channels"("id"),
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "usage_events" (
	"request_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
	"api_key_id" uuid REFERENCES "api_keys"("id"),
	"channel_id" text NOT NULL REFERENCES "channels"("id"),
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"latency_ms" integer,
	"status" text NOT NULL CHECK (status IN ('ok', 'failed', 'rejected')),
	"cost_usd" numeric(12, 6),
	"credits_charged" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "billing_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "admin_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL REFERENCES "profiles"("id"),
	"action" text NOT NULL,
	"target" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX "api_keys_owner_id_idx" ON "api_keys" ("owner_id");
CREATE INDEX "ledger_user_id_idx" ON "ledger" ("user_id");
CREATE INDEX "usage_events_user_id_idx" ON "usage_events" ("user_id");
CREATE INDEX "usage_events_created_at_idx" ON "usage_events" ("created_at");
CREATE INDEX "provider_credentials_owner_id_idx" ON "provider_credentials" ("owner_id");
CREATE INDEX "admin_audit_log_actor_id_idx" ON "admin_audit_log" ("actor_id");
CREATE INDEX "channels_task_status_idx" ON "channels" ("task", "status");

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entitlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_audit_log" ENABLE ROW LEVEL SECURITY;

-- profiles: users read + update only their own row.
-- role is protected by column-level grants below, not by policy.
CREATE POLICY "profiles_select_own"
  ON "profiles" FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = id);

CREATE POLICY "profiles_update_own"
  ON "profiles" FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

-- api_keys / entitlements / ledger / usage_events:
-- owner-scoped SELECT only. No INSERT/UPDATE/DELETE policies exist,
-- so client writes are denied by default. Server code uses service role.
CREATE POLICY "api_keys_select_own"
  ON "api_keys" FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = owner_id);

CREATE POLICY "entitlements_select_own"
  ON "entitlements" FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "ledger_select_own"
  ON "ledger" FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "usage_events_select_own"
  ON "usage_events" FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- channels, provider_credentials, billing_events, admin_audit_log:
-- RLS enabled with ZERO policies = no client access whatsoever.
-- Admin access goes through server routes using the service role.

-- ============================================================
-- Grants (explicit matrix — never rely on default privileges)
-- ============================================================

-- Start from zero for the API-facing roles on every table.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated, anon;

-- service_role: server code writes everything.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- authenticated: owner-scoped reads only (RLS narrows to own rows).
GRANT SELECT ON "profiles" TO authenticated;
GRANT SELECT ON "api_keys" TO authenticated;
GRANT SELECT ON "entitlements" TO authenticated;
GRANT SELECT ON "ledger" TO authenticated;
GRANT SELECT ON "usage_events" TO authenticated;

-- Users may edit their own email; role is NOT grantable — column-level
-- restriction enforcing that clients can never change profiles.role.
GRANT UPDATE ("email") ON "profiles" TO authenticated;

-- anon gets nothing. channels, provider_credentials, billing_events,
-- admin_audit_log get no client grants at all (server/service-role only).

-- ============================================================
-- Signup trigger: create a profiles row for every new auth user
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (new.id, new.email, 'developer');
  INSERT INTO public.entitlements (user_id)
  VALUES (new.id);
  RETURN new;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- User suspension kill switch.
--
-- A single `profiles.status` check inside authenticateApiKey covers every
-- present and future API endpoint, so an abusive account can be stopped
-- without deleting (and thus losing the history of) its auth user.

ALTER TABLE "profiles"
  ADD COLUMN "status" text DEFAULT 'active' NOT NULL
  CHECK (status IN ('active', 'suspended'));

-- Admins suspend/unsuspend through server actions using the service role, so
-- no client-facing grant is added or widened here. RLS on profiles stays as it
-- was: users select their own row (including this column) and may only update
-- `email` via the existing column-level grant.
CREATE INDEX "profiles_status_idx" ON "profiles" ("status");
-- Routing eligibility must not depend on a price. Preserve the old catalogue
-- exactly for this release, then let sources own the platform multiplier.
ALTER TABLE channels ADD COLUMN is_byok boolean NOT NULL DEFAULT false;
UPDATE channels SET is_byok = true WHERE credit_multiplier = 0;
ALTER TABLE channels ADD CONSTRAINT channels_byok_multiplier_check
  CHECK (NOT is_byok OR credit_multiplier = 0);
CREATE INDEX channels_is_byok_idx ON channels(is_byok);

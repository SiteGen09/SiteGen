-- Why a request ended without an answer. A refusal before routing (plan or
-- key limits, credits, moderation, a malformed body) has no channel, so
-- without its code the admin usage view can only call it "unattributed" and
-- the reason survives nowhere but the process log.
--
-- Holds the gateway's own error code (lib/api/errors.ts ERROR_CODES), never a
-- provider message: consumers read their own usage_events rows. Null for
-- successful requests and for rows written before this column existed.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS error_code text;

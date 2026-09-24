-- Asynchronous media generation: images and video.
--
-- Both are the same call shape and the same billing unit, differing only in
-- how long they take and how large the result is, so they share one table and
-- one dispatcher. `kind` exists to label the job for callers and to pick a
-- file extension — not to branch the pipeline.
--
-- The upstream is a job queue, not a request: a create returns a task id in
-- milliseconds and the result lands a minute or more later. No synchronous
-- dispatcher can serve that, which is why none of this runs through the chat
-- pipeline. `channels.pricing_type = 'request'` has existed unused since the
-- catalogue landed, gated out of dispatch by `eligibleForPlan`; this is the
-- endpoint that finally understands that unit.

-- Per-request price for request-priced channels. Token rates stay NOT NULL and
-- zero for these rows: a price of "$0 per million tokens" is true of an image
-- model and says nothing, so the real price needs its own column.
ALTER TABLE channels ADD COLUMN request_price_usd numeric(12,6);
ALTER TABLE channels ADD CONSTRAINT channels_request_price_check
  CHECK (request_price_usd IS NULL OR request_price_usd >= 0);
-- A request-priced channel without a price would settle at zero credits, which
-- is worse than refusing to route it: it serves traffic for free and silently.
--
-- NOT VALID on purpose. The catalogue may already hold request-priced rows
-- from before this column existed, and they cannot be priced by a migration
-- that has no idea what they cost. Validating would fail the deployment; this
-- way the rule binds every insert and update from here on, while the unpriced
-- legacy rows stay unroutable — `selectMediaChannel` refuses a null price
-- rather than billing nothing. Run VALIDATE CONSTRAINT once they are priced.
ALTER TABLE channels ADD CONSTRAINT channels_request_price_present
  CHECK (pricing_type <> 'request' OR request_price_usd IS NOT NULL) NOT VALID;

-- `kie_jobs` is the provider kind for the async media queue. Unlike the other
-- kinds it is not a chat wire protocol at all, and `buildAI` refuses it on
-- purpose so it can never be dispatched as one.
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_provider_check;
ALTER TABLE channels ADD CONSTRAINT channels_provider_check
  CHECK (provider IN ('anthropic', 'anthropic_compatible', 'openai_compatible',
                      'openai_responses', 'kie_jobs'));

-- Media channels need tasks of their own. The existing values name units of
-- site-building work dispatched by the chat pipeline; a render job is neither,
-- and reusing one would make it selectable by `selectChannel`.
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_task_check;
ALTER TABLE channels ADD CONSTRAINT channels_task_check
  CHECK (task IN ('site.spec', 'site.copy', 'interview', 'chat.completions',
                  'image.generate', 'video.generate'));

CREATE TABLE media_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES api_keys(id),
  -- Null for jobs started from the dashboard, which authenticate by session.
  conversation_id uuid REFERENCES chat_conversations(id) ON DELETE SET NULL,
  -- The ledger key. Unique here as well as in `ledger`, so a retry cannot open
  -- a second job against one hold.
  request_id text NOT NULL UNIQUE,
  channel_id text NOT NULL REFERENCES channels(id),
  public_model_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'video')),
  -- Assigned after the upstream accepts the task, so it is null while queued.
  upstream_task_id text UNIQUE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed')),
  input jsonb NOT NULL,
  -- Proves an inbound callback is answering THIS job. Compared in constant
  -- time; a callback that cannot present it is refused, since the route is
  -- public by necessity.
  callback_token text NOT NULL,
  -- The durable copy in storage. `upstream_url` is kept for provenance only:
  -- it points at a temp host and will rot.
  storage_path text,
  upstream_url text,
  error_code text,
  error_message text,
  -- Snapshot of the source's markup at the moment of the hold. Settlement
  -- happens minutes later, and a multiplier edited in between must not reprice
  -- a job the caller already committed to.
  credit_multiplier numeric(10,2) NOT NULL DEFAULT 1.0 CHECK (credit_multiplier >= 0),
  credits_held bigint NOT NULL DEFAULT 0 CHECK (credits_held >= 0),
  credits_charged bigint CHECK (credits_charged >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- A terminal job must say how it ended; an open one must not pretend to have.
  CONSTRAINT media_jobs_terminal_complete CHECK (
    (status IN ('succeeded','failed')) = (completed_at IS NOT NULL)
  ),
  CONSTRAINT media_jobs_succeeded_has_file CHECK (
    status <> 'succeeded' OR storage_path IS NOT NULL
  )
);

CREATE INDEX media_jobs_user_idx ON media_jobs(user_id, created_at DESC);
-- Drives the polling backstop: open jobs only, so the sweep never scans history.
CREATE INDEX media_jobs_open_idx ON media_jobs(updated_at)
  WHERE status IN ('queued','running');
-- Rendering a conversation resolves its jobs in one pass.
CREATE INDEX media_jobs_conversation_idx ON media_jobs(conversation_id)
  WHERE conversation_id IS NOT NULL;

ALTER TABLE media_jobs ENABLE ROW LEVEL SECURITY;
-- Reads are direct from the browser; every write is billed and belongs to the
-- server pipeline, so no insert or update policy exists for `authenticated`.
CREATE POLICY media_jobs_read ON media_jobs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
GRANT SELECT ON media_jobs TO authenticated;
GRANT ALL ON media_jobs TO service_role;

-- Private bucket: results are served through signed URLs minted per request,
-- so a leaked object path is not itself a leak of the file. The size limit is
-- set per bucket because video is an order of magnitude larger than an image
-- and would otherwise hit the project-wide default.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('generated-media', 'generated-media', false, 209715200)
ON CONFLICT (id) DO UPDATE SET file_size_limit = EXCLUDED.file_size_limit;

-- Objects are laid out as `<user_id>/<job_id>.<ext>`, so the owner check is the
-- leading path segment. Writes are service-role only, as above.
CREATE POLICY generated_media_read ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'generated-media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- New keys can reach the media endpoints; existing keys deliberately cannot.
-- Widening a live key's scopes is a grant of capability, and grants belong to
-- the operator, not to a migration. To extend it to existing keys:
--   UPDATE api_keys SET scopes = array_append(scopes, 'media')
--   WHERE status = 'active' AND NOT ('media' = ANY(scopes));
ALTER TABLE api_keys ALTER COLUMN scopes SET DEFAULT '{generate,chat,media}';

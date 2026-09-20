-- One observation per channel/hour makes scheduler retries idempotent.
CREATE TABLE model_health_checks (
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  bucket_hour timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'error', 'timeout')),
  latency_ms integer CHECK (latency_ms >= 0),
  error_detail text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX model_health_checks_channel_hour_key ON model_health_checks(channel_id, bucket_hour);
CREATE INDEX model_health_checks_hour_idx ON model_health_checks(bucket_hour);
ALTER TABLE model_health_checks ENABLE ROW LEVEL SECURITY;
GRANT ALL ON model_health_checks TO service_role;

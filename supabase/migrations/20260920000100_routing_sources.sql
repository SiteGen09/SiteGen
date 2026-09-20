-- A source owns markup and vendor family, while channels retain wire protocol.
CREATE TABLE sources (
  id text PRIMARY KEY,
  family text NOT NULL CHECK (family IN ('gpt', 'claude', 'grok')),
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  credit_multiplier numeric(10,2) NOT NULL CHECK (credit_multiplier > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'off')),
  min_plan text NOT NULL DEFAULT 'free' CHECK (min_plan IN ('free', 'starter', 'pro')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sources_default_family_key ON sources(family) WHERE is_default;
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY sources_read ON sources FOR SELECT TO authenticated USING (true);
GRANT SELECT ON sources TO authenticated;
GRANT ALL ON sources TO service_role;

ALTER TABLE channels ADD COLUMN source_id text REFERENCES sources(id);
CREATE INDEX channels_source_id_idx ON channels(source_id);

-- The old data has no family. Infer only known model names, NEVER protocol;
-- unfamiliar production names require an explicit mapping before migration.
-- The local stub is deliberately assigned to GPT for development exercises.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM channels WHERE NOT is_byok AND
    lower(coalesce(public_model_id, '') || ' ' || model_id) !~ '(claude|grok|gpt|(^|[ /])o[134]([ -]|$)|stub)') THEN
    RAISE EXCEPTION 'Unmapped channel family: add an explicit model-name mapping to routing_sources before applying';
  END IF;
END $$;
INSERT INTO sources (id, family, label, description, credit_multiplier, min_plan)
SELECT 'legacy-' || id,
  CASE WHEN lower(coalesce(public_model_id, '') || ' ' || model_id) LIKE '%claude%' THEN 'claude'
       WHEN lower(coalesce(public_model_id, '') || ' ' || model_id) LIKE '%grok%' THEN 'grok'
       ELSE 'gpt' END,
  label, 'Migrated source; retains the original channel price.', credit_multiplier, min_plan
FROM channels WHERE NOT is_byok;
UPDATE channels SET source_id = 'legacy-' || id WHERE NOT is_byok;
ALTER TABLE channels ADD CONSTRAINT channels_source_check
  CHECK ((is_byok AND source_id IS NULL) OR (NOT is_byok AND source_id IS NOT NULL));
-- The obsolete value is a rollback snapshot only; new BYOK rows must also be
-- insertable without writing it. The explicit source constraint replaces it.
ALTER TABLE channels DROP CONSTRAINT channels_byok_multiplier_check;
DROP INDEX channels_public_model_id_key;
CREATE INDEX channels_public_model_id_idx ON channels(public_model_id) WHERE public_model_id IS NOT NULL;

CREATE TABLE user_routing_preferences (
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  family text NOT NULL CHECK (family IN ('gpt', 'claude', 'grok')),
  source_id text NOT NULL REFERENCES sources(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, family)
);
ALTER TABLE user_routing_preferences ENABLE ROW LEVEL SECURITY;
-- Direct browser writes must enforce the same family/status/plan rules as the
-- action. Ownership alone would allow bypassing the picker through REST.
CREATE POLICY routing_read ON user_routing_preferences FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY routing_insert ON user_routing_preferences FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM sources s WHERE s.id = source_id AND s.family = user_routing_preferences.family
      AND s.status <> 'off' AND array_position(ARRAY['free','starter','pro'], s.min_plan) <=
      array_position(ARRAY['free','starter','pro'], coalesce((SELECT plan_key FROM entitlements WHERE user_id = auth.uid()), 'free'))
  ));
CREATE POLICY routing_update ON user_routing_preferences FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM sources s WHERE s.id = source_id AND s.family = user_routing_preferences.family
      AND s.status <> 'off' AND array_position(ARRAY['free','starter','pro'], s.min_plan) <=
      array_position(ARRAY['free','starter','pro'], coalesce((SELECT plan_key FROM entitlements WHERE user_id = auth.uid()), 'free'))
  ));
GRANT SELECT, INSERT, UPDATE ON user_routing_preferences TO authenticated;
GRANT ALL ON user_routing_preferences TO service_role;

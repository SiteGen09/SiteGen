-- Reclaim stranded credit holds.
--
-- hold_credits writes a negative `hold` row before the provider call and is
-- only undone by settle_credits/release_credits. A process that dies in
-- between leaves that hold row and its debt in the ledger forever: nothing
-- else in the system ever removes it, so the customer's credits are
-- permanently gone and no operator action recovers them.
--
-- This finds holds older than a threshold with neither a `:settle` nor a
-- `:release` sibling and releases each one, exactly as release_credits would
-- have. Server-only: invoked by the reconcile cron with the service role.

CREATE OR REPLACE FUNCTION reclaim_stranded_holds(
  p_older_than interval DEFAULT interval '15 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  stranded record;
  reclaimed jsonb := '[]'::jsonb;
  reclaimed_credits bigint := 0;
BEGIN
  -- A hold is abandoned when it is older than the threshold and has no
  -- terminal sibling. `FOR UPDATE OF l` skips rows another sweeper is already
  -- releasing, so two overlapping cron runs cannot double-release.
  FOR stranded IN
    SELECT l.id, l.user_id, l.request_id, l.channel_id, l.credits, l.created_at
    FROM ledger l
    WHERE l.kind = 'hold'
      AND l.created_at < now() - p_older_than
      AND NOT EXISTS (
        SELECT 1 FROM ledger t
        WHERE t.request_id IN (l.request_id || ':settle', l.request_id || ':release')
      )
    ORDER BY l.id
    FOR UPDATE OF l SKIP LOCKED
  LOOP
    -- Serialize against hold/settle for this user, matching release_credits.
    PERFORM 1 FROM profiles WHERE id = stranded.user_id FOR UPDATE;

    -- Re-check under the lock: a settle may have landed between the scan above
    -- and the row lock, and releasing then would refund a completed call.
    PERFORM 1 FROM ledger
    WHERE request_id IN (stranded.request_id || ':settle', stranded.request_id || ':release');
    IF FOUND THEN
      CONTINUE;
    END IF;

    INSERT INTO ledger (user_id, request_id, kind, credits, channel_id, meta)
    VALUES (
      stranded.user_id, stranded.request_id || ':release', 'release',
      -stranded.credits, stranded.channel_id,
      jsonb_build_object('for', 'reclaim_stranded_hold')
    );

    reclaimed_credits := reclaimed_credits + (-stranded.credits);
    reclaimed := reclaimed || jsonb_build_object(
      'request_id', stranded.request_id,
      'user_id', stranded.user_id,
      'credits', -stranded.credits,
      'held_since', stranded.created_at
    );
  END LOOP;

  RETURN jsonb_build_object(
    'count', jsonb_array_length(reclaimed),
    'credits', reclaimed_credits,
    'holds', reclaimed
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION reclaim_stranded_holds(interval) FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION reclaim_stranded_holds(interval) TO service_role;
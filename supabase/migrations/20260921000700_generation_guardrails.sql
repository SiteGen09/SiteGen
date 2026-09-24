-- Lightweight shared abuse controls. No prompt text or raw IPs are stored.
CREATE TABLE public.guard_counters (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL
);
CREATE TABLE public.guard_leases (
  request_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX guard_leases_user_idx ON public.guard_leases(user_id, expires_at);
CREATE TABLE public.guard_cooldowns (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_until timestamptz NOT NULL
);
CREATE TABLE public.guard_violations (
  request_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guard_violations_user_idx ON public.guard_violations(user_id, created_at);
ALTER TABLE public.guard_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guard_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guard_cooldowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guard_violations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.guard_counters, public.guard_leases, public.guard_cooldowns, public.guard_violations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.guard_counters, public.guard_leases, public.guard_cooldowns, public.guard_violations TO service_role;

CREATE FUNCTION public.guard_admit(p_user uuid, p_request text, p_ip text,
  p_account_rpm integer, p_ip_rpm integer, p_concurrency integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  tick timestamptz := clock_timestamp();
  minute_start timestamptz := date_trunc('minute', tick);
  account_status text;
  blocked timestamptz;
  n integer;
BEGIN
  IF p_account_rpm < 1 OR p_ip_rpm < 1 OR p_concurrency < 1 THEN
    RAISE EXCEPTION 'invalid guard limits';
  END IF;
  -- A common lock order serializes simultaneous requests across app instances.
  IF p_ip IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('guard-ip:' || p_ip, 0));
  END IF;
  SELECT status INTO account_status FROM profiles WHERE id = p_user FOR UPDATE;
  IF account_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'inactive');
  END IF;
  SELECT blocked_until INTO blocked FROM guard_cooldowns WHERE user_id = p_user;
  IF blocked > tick THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'cooldown', 'retry_after', ceil(extract(epoch FROM blocked - tick)));
  END IF;

  INSERT INTO guard_counters AS c VALUES ('user:' || p_user, minute_start, 1)
  ON CONFLICT (bucket) DO UPDATE SET window_start = minute_start,
    hits = CASE WHEN c.window_start = minute_start THEN c.hits + 1 ELSE 1 END
  RETURNING hits INTO n;
  IF n > p_account_rpm THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'rate', 'retry_after', 60);
  END IF;
  IF p_ip IS NOT NULL THEN
    INSERT INTO guard_counters AS c VALUES ('ip:' || p_ip, minute_start, 1)
    ON CONFLICT (bucket) DO UPDATE SET window_start = minute_start,
      hits = CASE WHEN c.window_start = minute_start THEN c.hits + 1 ELSE 1 END
    RETURNING hits INTO n;
    IF n > p_ip_rpm THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'rate', 'retry_after', 60);
    END IF;
  END IF;
  DELETE FROM guard_leases WHERE user_id = p_user AND expires_at <= tick;
  -- Async media still occupies a slot after its HTTP response has returned.
  SELECT count(*) INTO n FROM (
    SELECT request_id FROM guard_leases WHERE user_id = p_user
    UNION
    SELECT request_id FROM media_jobs WHERE user_id = p_user AND status IN ('queued', 'running')
  ) active;
  IF n >= p_concurrency THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'concurrency', 'retry_after', 10);
  END IF;
  -- Longer than the maximum route duration; abandoned leases recover automatically.
  INSERT INTO guard_leases VALUES (p_request, p_user, tick + interval '10 minutes');
  DELETE FROM guard_counters WHERE window_start < tick - interval '1 day';
  RETURN jsonb_build_object('allowed', true);
END;
$$;

CREATE FUNCTION public.guard_release(p_request text) RETURNS void
LANGUAGE sql SET search_path = public AS $$
  DELETE FROM guard_leases WHERE request_id = p_request;
$$;

CREATE FUNCTION public.guard_record_violation(p_user uuid, p_request text, p_category text,
  p_threshold integer, p_cooldown_seconds integer) RETURNS void
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer; added integer;
BEGIN
  IF p_threshold < 1 OR p_cooldown_seconds < 1 THEN RAISE EXCEPTION 'invalid guard limits'; END IF;
  PERFORM 1 FROM profiles WHERE id = p_user FOR UPDATE;
  INSERT INTO guard_violations(request_id, user_id, category) VALUES (p_request, p_user, p_category)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  IF added = 0 THEN RETURN; END IF;
  -- Preserve the existing admin strikes view without storing raw prompts.
  INSERT INTO abuse_strikes(user_id, request_id, categories) VALUES (p_user, p_request, ARRAY[p_category]);
  SELECT count(*) INTO n FROM guard_violations WHERE user_id = p_user
    AND created_at >= now() - interval '24 hours';
  IF n >= p_threshold THEN
    INSERT INTO guard_cooldowns VALUES (p_user, now() + make_interval(secs => p_cooldown_seconds))
      ON CONFLICT (user_id) DO UPDATE SET blocked_until = greatest(guard_cooldowns.blocked_until, excluded.blocked_until);
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.guard_admit(uuid,text,text,integer,integer,integer), public.guard_release(text), public.guard_record_violation(uuid,text,text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_admit(uuid,text,text,integer,integer,integer), public.guard_release(text), public.guard_record_violation(uuid,text,text,integer,integer) TO service_role;

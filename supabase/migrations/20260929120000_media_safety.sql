-- Image and video safety: policy consent, the refusal log, and a media-only
-- suspension. Neither prompt text nor uploaded files are stored here, only
-- SHA-256 digests, so a refused request leaves no prohibited content behind.

-- Clients hold UPDATE on profiles.email only, so none of these can be set from
-- the browser; the server writes them with the service role.
ALTER TABLE public.profiles
  ADD COLUMN media_policy_accepted_at timestamptz,
  ADD COLUMN media_suspended_at timestamptz,
  ADD COLUMN media_suspended_reason text;

CREATE TABLE public.media_safety_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  job_id uuid REFERENCES public.media_jobs(id) ON DELETE SET NULL,
  stage text NOT NULL CHECK (stage IN ('prompt', 'reference', 'output')),
  rule text NOT NULL,
  severe boolean NOT NULL DEFAULT false,
  prompt_sha256 text,
  reference_sha256 text[] NOT NULL DEFAULT '{}',
  -- 'rules', 'classifier:<model>' or 'provider'.
  decided_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A callback and the polling sweep can screen the same output twice; one
-- refusal per request and stage keeps that from counting as two violations.
CREATE UNIQUE INDEX media_safety_events_request_stage_idx ON public.media_safety_events(request_id, stage);
CREATE INDEX media_safety_events_user_idx ON public.media_safety_events(user_id, created_at DESC);

ALTER TABLE public.media_safety_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_safety_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.media_safety_events TO service_role;

-- Records one refusal and suspends media generation when it is severe or when
-- the user has reached the threshold within the window. Suspension is sticky:
-- only an administrator clears it.
CREATE FUNCTION public.record_media_violation(
  p_user uuid, p_request text, p_job uuid, p_stage text, p_rule text, p_severe boolean,
  p_prompt_sha256 text, p_reference_sha256 text[], p_decided_by text,
  p_threshold integer, p_window_days integer
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer; added integer; suspended boolean := false;
BEGIN
  IF p_threshold < 1 OR p_window_days < 1 THEN RAISE EXCEPTION 'invalid media safety limits'; END IF;
  PERFORM 1 FROM profiles WHERE id = p_user FOR UPDATE;
  INSERT INTO media_safety_events(user_id, request_id, job_id, stage, rule, severe, prompt_sha256, reference_sha256, decided_by)
    VALUES (p_user, p_request, p_job, p_stage, p_rule, p_severe, p_prompt_sha256, coalesce(p_reference_sha256, '{}'), p_decided_by)
    ON CONFLICT (request_id, stage) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  SELECT count(*) INTO n FROM media_safety_events
    WHERE user_id = p_user AND created_at >= now() - make_interval(days => p_window_days);
  IF added > 0 AND (p_severe OR n >= p_threshold) THEN
    UPDATE profiles SET
      media_suspended_at = coalesce(media_suspended_at, now()),
      media_suspended_reason = coalesce(media_suspended_reason,
        CASE WHEN p_severe THEN 'severe violation: ' || p_rule ELSE 'repeated violations' END)
    WHERE id = p_user;
    suspended := true;
  END IF;
  RETURN jsonb_build_object('recorded', added > 0, 'count', n, 'suspended', suspended);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_media_violation(uuid, text, uuid, text, text, boolean, text, text[], text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_media_violation(uuid, text, uuid, text, text, boolean, text, text[], text, integer, integer) TO service_role;

-- Retention. Generated files and checked reference copies are kept for a
-- limited time (7 days by default) and within a storage budget, so the
-- project stays inside its storage allowance. The job row stays for billing
-- history; its input (prompt and reference URLs) is cleared when it expires.
ALTER TABLE public.media_jobs ADD COLUMN expired_at timestamptz;

-- Files to delete: everything older than the cutoff, plus the oldest files
-- beyond the byte budget, newest kept first. Deletion itself goes through
-- the Storage API, which removes the object as well as its row.
CREATE FUNCTION public.media_retention_candidates(p_cutoff timestamptz, p_budget_bytes bigint, p_limit integer)
RETURNS TABLE (name text, bytes bigint, reason text)
LANGUAGE sql STABLE SET search_path = public, storage AS $$
  WITH objects AS (
    SELECT o.name, coalesce((o.metadata->>'size')::bigint, 0) AS bytes, o.created_at
    FROM storage.objects o
    WHERE o.bucket_id = 'generated-media'
  ), ranked AS (
    SELECT objects.*, sum(objects.bytes) OVER (ORDER BY objects.created_at DESC, objects.name) AS newer_total
    FROM objects
  )
  SELECT ranked.name, ranked.bytes, CASE WHEN ranked.created_at < p_cutoff THEN 'age' ELSE 'budget' END
  FROM ranked
  WHERE ranked.created_at < p_cutoff OR ranked.newer_total > p_budget_bytes
  ORDER BY ranked.created_at
  LIMIT p_limit;
$$;
REVOKE EXECUTE ON FUNCTION public.media_retention_candidates(timestamptz, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_retention_candidates(timestamptz, bigint, integer) TO service_role;

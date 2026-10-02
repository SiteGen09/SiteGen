-- Sign in with a username as well as an email.
--
-- Usernames were only kept in auth.users.raw_user_meta_data and were not
-- unique. They now live on profiles, unique regardless of case, and the
-- signup trigger copies them across. Login resolves a username to its email
-- on the server only after the password matches, so a username never reveals
-- an email address. Supabase then performs the real sign-in with that email.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username text
  CHECK (username IS NULL OR username ~ '^[a-zA-Z0-9_.-]{3,32}$');
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_key ON public.profiles (lower(username));

-- Earliest account keeps a username when older signups collide.
UPDATE public.profiles p SET username = u.raw_user_meta_data->>'username'
FROM auth.users u
WHERE u.id = p.id AND p.username IS NULL
  AND u.raw_user_meta_data->>'username' ~ '^[a-zA-Z0-9_.-]{3,32}$'
  AND NOT EXISTS (
    SELECT 1 FROM auth.users o
    WHERE lower(o.raw_user_meta_data->>'username') = lower(u.raw_user_meta_data->>'username')
      AND (o.created_at, o.id) < (u.created_at, u.id)
  );

-- A username already taken (a race the signup form's check cannot close)
-- leaves the new account without one rather than failing the signup.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  wanted text := new.raw_user_meta_data->>'username';
BEGIN
  IF wanted !~ '^[a-zA-Z0-9_.-]{3,32}$' THEN wanted := NULL; END IF;
  BEGIN
    INSERT INTO public.profiles (id, email, role, username) VALUES (new.id, new.email, 'developer', wanted);
  EXCEPTION WHEN unique_violation THEN
    IF wanted IS NULL THEN RAISE; END IF;
    INSERT INTO public.profiles (id, email, role) VALUES (new.id, new.email, 'developer');
  END;
  INSERT INTO public.entitlements (user_id) VALUES (new.id);
  RETURN new;
END;
$$;

CREATE OR REPLACE FUNCTION public.username_available(p_username text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_username ~ '^[a-zA-Z0-9_.-]{3,32}$'
    AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE lower(username) = lower(p_username));
$$;

-- Returns {status: ok|invalid|rate_limited, email}. Rate limited per client
-- address and per username, because this checks passwords outside Supabase
-- Auth's own limits. Accounts without a password (Google only) never match.
CREATE OR REPLACE FUNCTION public.username_login_email(p_username text, p_password text, p_ip text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  tick timestamptz := date_trunc('minute', clock_timestamp());
  ip_hits integer;
  name_hits integer;
  found_email text;
BEGIN
  IF p_username IS NULL OR p_password IS NULL OR p_username !~ '^[a-zA-Z0-9_.-]{3,32}$'
     OR length(p_password) = 0 OR length(p_password) > 72 THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  INSERT INTO public.guard_counters AS c (bucket, window_start, hits)
  VALUES ('login-ip:' || COALESCE(NULLIF(p_ip, ''), 'unknown'), tick, 1)
  ON CONFLICT (bucket) DO UPDATE SET window_start = tick,
    hits = CASE WHEN c.window_start = tick THEN c.hits + 1 ELSE 1 END
  RETURNING hits INTO ip_hits;
  INSERT INTO public.guard_counters AS c (bucket, window_start, hits)
  VALUES ('login-name:' || lower(p_username), tick, 1)
  ON CONFLICT (bucket) DO UPDATE SET window_start = tick,
    hits = CASE WHEN c.window_start = tick THEN c.hits + 1 ELSE 1 END
  RETURNING hits INTO name_hits;
  IF ip_hits > 10 OR name_hits > 5 THEN RETURN jsonb_build_object('status', 'rate_limited'); END IF;

  SELECT u.email INTO found_email
  FROM public.profiles p JOIN auth.users u ON u.id = p.id
  WHERE lower(p.username) = lower(p_username) AND u.deleted_at IS NULL
    AND COALESCE(u.encrypted_password, '') <> ''
    AND u.encrypted_password = extensions.crypt(p_password, u.encrypted_password);
  IF found_email IS NULL THEN RETURN jsonb_build_object('status', 'invalid'); END IF;
  RETURN jsonb_build_object('status', 'ok', 'email', found_email);
END;
$$;

REVOKE ALL ON FUNCTION public.username_available(text), public.username_login_email(text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.username_available(text), public.username_login_email(text, text, text)
  TO service_role;
NOTIFY pgrst, 'reload schema';

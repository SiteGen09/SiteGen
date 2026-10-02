-- In-app notifications for consumers: platform events found by the scanner in
-- lib/notifications/scan.ts (models added or removed, price changes, low
-- balance, API keys expiring or near quota), support replies, and
-- administrator announcements. Server-only: the app reads and writes these
-- through its own database connection, scoped to the signed-in user.
CREATE TABLE public.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN (
    'model_added', 'model_removed', 'price_change', 'announcement',
    'low_balance', 'key_expiring', 'key_quota', 'support_reply')),
  -- NULL is a broadcast to every user on min_plan or above.
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  min_plan text NOT NULL DEFAULT 'free',
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 5000),
  -- In-app paths only, so a notification can never send a user off-site.
  link text CHECK (link IS NULL OR (link ~ '^/[^/\\]' AND char_length(link) <= 500)),
  important boolean NOT NULL DEFAULT false,
  -- Makes a scanner event idempotent across runs and processes.
  dedupe_key text UNIQUE,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT notifications_personal_kinds CHECK (
    kind IN ('model_added', 'model_removed', 'price_change', 'announcement') OR user_id IS NOT NULL)
);
CREATE INDEX notifications_broadcast_idx ON public.notifications (created_at DESC) WHERE user_id IS NULL;
CREATE INDEX notifications_user_idx ON public.notifications (user_id, created_at DESC) WHERE user_id IS NOT NULL;

CREATE TABLE public.notification_reads (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notification_id bigint NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);

-- seen_before: "mark all as read" watermark; NULL means everything before
-- signup. low_balance_notified: the balance alert fires once per drop and
-- re-arms once the balance recovers; NULL until the scanner first sees the
-- user, so a balance that was already low is not announced as news.
CREATE TABLE public.notification_user_state (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  seen_before timestamptz,
  low_balance_notified boolean
);

-- The public models consumers could reach at the last scan. missing_since
-- delays a removal notice so a brief outage or an admin toggle is not news.
CREATE TABLE public.notification_model_catalog (
  public_model_id text PRIMARY KEY,
  modality text NOT NULL,
  missing_since timestamptz
);

CREATE TABLE public.notification_cursors (
  name text PRIMARY KEY,
  value bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_user_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_model_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notifications, public.notification_reads, public.notification_user_state,
  public.notification_model_catalog, public.notification_cursors FROM PUBLIC, anon, authenticated;

-- Customer support: an AI setup assistant and human support requests.
--
-- Every read and write goes through the server (service role or the direct
-- DATABASE_URL connection) after it has checked the session, so no client role
-- is granted anything. A browser cannot forge a staff reply, read another
-- account's ticket, or append assistant turns that were never generated.

-- One row per assistant turn. `session_id` groups a conversation: starting a
-- new one mints a fresh id, and the old turns stay for staff to read when a
-- ticket links them. Token counts and cost are recorded because the platform
-- pays for these calls rather than the customer.
CREATE TABLE support_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
  model text,
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  cost_usd numeric(12, 6) CHECK (cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_chat_messages_user_idx ON support_chat_messages (user_id, created_at DESC);
CREATE INDEX support_chat_messages_session_idx ON support_chat_messages (session_id, created_at);

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What a customer quotes ("request #1042"); the uuid stays internal.
  number bigint GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 160),
  category text NOT NULL CHECK (category IN ('setup', 'payment', 'api', 'balance', 'account', 'bug', 'feature', 'other')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  -- open: waiting on staff. answered: staff replied, waiting on the customer.
  -- closed: resolved; a customer reply reopens it.
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  request_id text CHECK (char_length(request_id) <= 128),
  order_id text CHECK (char_length(order_id) <= 128),
  diagnostics jsonb,
  -- The assistant conversation the customer escalated from, if any.
  chat_session_id uuid,
  -- A staff reply the customer has not opened yet.
  customer_unread boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX support_tickets_user_idx ON support_tickets (user_id, updated_at DESC);
CREATE INDEX support_tickets_queue_idx ON support_tickets (status, updated_at DESC);

CREATE TABLE support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  author_role text NOT NULL CHECK (author_role IN ('customer', 'staff')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_ticket_messages_ticket_idx ON support_ticket_messages (ticket_id, created_at);

-- Screenshots and logs. Held in the database rather than a storage bucket so
-- the feature needs no bucket setup; the app caps each file at 4 MB and a
-- message at three files.
CREATE TABLE support_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES support_ticket_messages(id) ON DELETE CASCADE,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 200),
  media_type text NOT NULL CHECK (char_length(media_type) <= 100),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 4194304),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_attachments_message_idx ON support_attachments (message_id);

ALTER TABLE support_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_attachments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON support_chat_messages, support_tickets, support_ticket_messages, support_attachments
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON support_chat_messages, support_tickets, support_ticket_messages, support_attachments
  TO service_role;

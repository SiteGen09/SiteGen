CREATE TABLE chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  model text NOT NULL,
  -- A bounded lease prevents two tabs appending competing assistant turns.
  active_request_id uuid,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_conversations_user_idx ON chat_conversations(user_id, updated_at);
CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content text NOT NULL,
  model text NOT NULL,
  tokens integer CHECK (tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conversation_idx ON chat_messages(conversation_id, created_at);
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
-- Browser reads are direct. Only the billed server pipeline may write turns,
-- so an authenticated browser cannot forge an assistant completion or token count.
CREATE POLICY chat_conversations_read ON chat_conversations FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY chat_messages_read ON chat_messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = conversation_id AND c.user_id = auth.uid()));
GRANT SELECT ON chat_conversations, chat_messages TO authenticated;
GRANT ALL ON chat_conversations, chat_messages TO service_role;

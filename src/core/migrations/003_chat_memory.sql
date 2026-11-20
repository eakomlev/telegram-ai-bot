ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id INTEGER NULL;

CREATE TABLE IF NOT EXISTS chat_memory (
  chat_id BIGINT PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '',
  pinned TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_until TIMESTAMPTZ NULL,
  last_run_on DATE NULL,
  claimed_until TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS chat_memory_due
  ON chat_memory (last_run_on, claimed_until);

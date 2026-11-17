CREATE TABLE IF NOT EXISTS messages (
  chat_id BIGINT NOT NULL,
  message_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  message_thread_id INTEGER NULL,
  is_bot BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (chat_id, message_id)
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_thread_id INTEGER NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_user_id BIGINT NULL;
CREATE INDEX IF NOT EXISTS messages_chat_time ON messages (chat_id, sent_at DESC, message_id DESC);
CREATE INDEX IF NOT EXISTS messages_chat_thread_time
  ON messages (chat_id, message_thread_id, sent_at DESC, message_id DESC);
CREATE INDEX IF NOT EXISTS messages_chat_author_time
  ON messages (chat_id, author_user_id, sent_at DESC)
  WHERE is_bot = false AND author_user_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS summary_requests (
  chat_id BIGINT PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS video_cache (
  source_url TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  quality_key TEXT NOT NULL,
  caption TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_cache_last_used ON video_cache (last_used_at ASC);
CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id BIGINT PRIMARY KEY,
  summary_admin_only BOOLEAN NOT NULL,
  default_message_count INTEGER NOT NULL,
  video_enabled BOOLEAN NOT NULL,
  gallery_enabled BOOLEAN NOT NULL,
  media_cooldown_seconds INTEGER NOT NULL,
  sarcasm_level INTEGER NOT NULL DEFAULT 0,
  response_tone TEXT NOT NULL DEFAULT 'gentleman',
  mention_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS sarcasm_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS response_tone TEXT NOT NULL DEFAULT 'gentleman';
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS mention_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS news_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS news_spheres TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS news_next_run_at TIMESTAMPTZ NULL;
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS news_last_sent_on DATE NULL;
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS auto_answer_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS personalization_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS personalization_last_run_on DATE NULL;
CREATE INDEX IF NOT EXISTS chat_settings_news_due ON chat_settings (news_next_run_at)
  WHERE news_enabled;
CREATE INDEX IF NOT EXISTS chat_settings_personalization_due ON chat_settings (personalization_last_run_on)
  WHERE personalization_enabled;
CREATE TABLE IF NOT EXISTS pending_auto_answers (
  chat_id BIGINT NOT NULL,
  message_id INTEGER NOT NULL,
  message_thread_id INTEGER NULL,
  author TEXT NOT NULL,
  question_text TEXT NOT NULL,
  asker_user_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  claimed_until TIMESTAMPTZ NULL,
  answer_text TEXT NULL,
  PRIMARY KEY (chat_id, message_id)
);
ALTER TABLE pending_auto_answers ADD COLUMN IF NOT EXISTS answer_text TEXT NULL;
CREATE INDEX IF NOT EXISTS pending_auto_answers_due
  ON pending_auto_answers (due_at)
  WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS openai_usage (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  image_count INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openai_usage_chat_time ON openai_usage (chat_id, created_at DESC);
CREATE TABLE IF NOT EXISTS chat_member_snapshots (
  chat_id BIGINT NOT NULL,
  captured_on DATE NOT NULL,
  member_count INTEGER NOT NULL,
  PRIMARY KEY (chat_id, captured_on)
);
CREATE INDEX IF NOT EXISTS chat_member_snapshots_day ON chat_member_snapshots (captured_on DESC);
CREATE TABLE IF NOT EXISTS chat_participants (
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT NULL,
  display_name TEXT NOT NULL,
  characteristic TEXT NULL,
  characteristic_updated_at TIMESTAMPTZ NULL,
  characteristic_source_until TIMESTAMPTZ NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_participants_chat_seen
  ON chat_participants (chat_id, last_seen_at DESC);

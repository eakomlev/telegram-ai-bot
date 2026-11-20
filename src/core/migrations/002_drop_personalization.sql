DROP INDEX IF EXISTS chat_settings_personalization_due;
ALTER TABLE chat_settings DROP COLUMN IF EXISTS personalization_last_run_on;
ALTER TABLE chat_settings DROP COLUMN IF EXISTS personalization_enabled;
DROP TABLE IF EXISTS chat_participants;

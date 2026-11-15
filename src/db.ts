import pg from 'pg';
import { config } from './config.js';
import type { ChatMessage, Selection } from './summary.js';

export const pool = new pg.Pool({
  ...(config.DATABASE_URL ? { connectionString: config.DATABASE_URL } : {}),
  max: config.PG_POOL_MAX,
  connectionTimeoutMillis: config.PG_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: config.PG_IDLE_TIMEOUT_MS,
  statement_timeout: config.PG_STATEMENT_TIMEOUT_MS,
});
pool.on('error', () => console.error('Postgres connection error'));

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      chat_id BIGINT NOT NULL,
      message_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS messages_chat_time ON messages (chat_id, sent_at DESC, message_id DESC);
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
      mention_enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS sarcasm_level INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS mention_enabled BOOLEAN NOT NULL DEFAULT true;
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
  `);
}

export type OpenAiUsageKind = 'summary' | 'mention' | 'gif';

export type OpenAiUsageRecord = {
  kind: OpenAiUsageKind;
  model: string;
  promptTokens: number;
  completionTokens: number;
  imageCount: number;
  estimatedCostUsd: number;
};

export type OpenAiUsageTotals = {
  requests: number;
  summaryRequests: number;
  mentionRequests: number;
  gifRequests: number;
  promptTokens: number;
  completionTokens: number;
  imageCount: number;
  estimatedCostUsd: number;
};

const emptyUsageTotals = (): OpenAiUsageTotals => ({
  requests: 0,
  summaryRequests: 0,
  mentionRequests: 0,
  gifRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  imageCount: 0,
  estimatedCostUsd: 0,
});

export async function recordOpenAiUsage(chatId: number, usage: OpenAiUsageRecord) {
  await pool.query(
    `INSERT INTO openai_usage (
      chat_id, kind, model, prompt_tokens, completion_tokens, image_count, estimated_cost_usd, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      String(chatId),
      usage.kind,
      usage.model,
      usage.promptTokens,
      usage.completionTokens,
      usage.imageCount,
      usage.estimatedCostUsd,
    ],
  );
}

function mapUsageTotals(row: {
  requests: string;
  summary_requests: string;
  mention_requests: string;
  gif_requests: string;
  prompt_tokens: string;
  completion_tokens: string;
  image_count: string;
  estimated_cost_usd: string;
} | undefined): OpenAiUsageTotals {
  if (!row) return emptyUsageTotals();
  return {
    requests: Number(row.requests) || 0,
    summaryRequests: Number(row.summary_requests) || 0,
    mentionRequests: Number(row.mention_requests) || 0,
    gifRequests: Number(row.gif_requests) || 0,
    promptTokens: Number(row.prompt_tokens) || 0,
    completionTokens: Number(row.completion_tokens) || 0,
    imageCount: Number(row.image_count) || 0,
    estimatedCostUsd: Number(row.estimated_cost_usd) || 0,
  };
}

const USAGE_TOTALS_SELECT = `
  COUNT(*)::text AS requests,
  COUNT(*) FILTER (WHERE kind = 'summary')::text AS summary_requests,
  COUNT(*) FILTER (WHERE kind = 'mention')::text AS mention_requests,
  COUNT(*) FILTER (WHERE kind = 'gif')::text AS gif_requests,
  COALESCE(SUM(prompt_tokens), 0)::text AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0)::text AS completion_tokens,
  COALESCE(SUM(image_count), 0)::text AS image_count,
  COALESCE(SUM(estimated_cost_usd), 0)::text AS estimated_cost_usd
`;

export async function getOpenAiUsageTotals(chatId: number, since?: Date): Promise<OpenAiUsageTotals> {
  const result = await pool.query<{
    requests: string;
    summary_requests: string;
    mention_requests: string;
    gif_requests: string;
    prompt_tokens: string;
    completion_tokens: string;
    image_count: string;
    estimated_cost_usd: string;
  }>(
    `SELECT ${USAGE_TOTALS_SELECT}
     FROM openai_usage
     WHERE chat_id = $1
       AND ($2::timestamptz IS NULL OR created_at >= $2)`,
    [String(chatId), since ?? null],
  );
  return mapUsageTotals(result.rows[0]);
}

export async function getGlobalOpenAiUsageTotals(since?: Date): Promise<OpenAiUsageTotals> {
  const result = await pool.query<{
    requests: string;
    summary_requests: string;
    mention_requests: string;
    gif_requests: string;
    prompt_tokens: string;
    completion_tokens: string;
    image_count: string;
    estimated_cost_usd: string;
  }>(
    `SELECT ${USAGE_TOTALS_SELECT}
     FROM openai_usage
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)`,
    [since ?? null],
  );
  return mapUsageTotals(result.rows[0]);
}

export type OpenAiUsageChatRow = OpenAiUsageTotals & { chatId: number };

export async function countOpenAiUsageChats(since?: Date): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT chat_id)::text AS count
     FROM openai_usage
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)`,
    [since ?? null],
  );
  return Number(result.rows[0]?.count) || 0;
}

/** Groups whose first recorded OpenAI usage falls on/after `since`. */
export async function countNewOpenAiUsageChats(since: Date): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM (
       SELECT chat_id
       FROM openai_usage
       GROUP BY chat_id
       HAVING MIN(created_at) >= $1
     ) AS first_seen`,
    [since],
  );
  return Number(result.rows[0]?.count) || 0;
}

export async function getOpenAiUsageByChat(since?: Date, limit = 30): Promise<OpenAiUsageChatRow[]> {
  const result = await pool.query<{
    chat_id: string;
    requests: string;
    summary_requests: string;
    mention_requests: string;
    gif_requests: string;
    prompt_tokens: string;
    completion_tokens: string;
    image_count: string;
    estimated_cost_usd: string;
  }>(
    `SELECT chat_id::text AS chat_id, ${USAGE_TOTALS_SELECT}
     FROM openai_usage
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)
     GROUP BY chat_id
     ORDER BY SUM(estimated_cost_usd) DESC, COUNT(*) DESC
     LIMIT $2`,
    [since ?? null, limit],
  );
  return result.rows.map((row) => ({
    chatId: Number(row.chat_id),
    ...mapUsageTotals(row),
  }));
}

export type ChatSettingsRow = {
  summary_admin_only: boolean;
  default_message_count: number;
  video_enabled: boolean;
  gallery_enabled: boolean;
  media_cooldown_seconds: number;
  sarcasm_level: number;
  mention_enabled: boolean;
};

export async function getChatSettingsRow(chatId: number): Promise<ChatSettingsRow | undefined> {
  const result = await pool.query<ChatSettingsRow>(
    `SELECT summary_admin_only, default_message_count, video_enabled, gallery_enabled, media_cooldown_seconds, sarcasm_level, mention_enabled
     FROM chat_settings WHERE chat_id = $1`,
    [String(chatId)],
  );
  return result.rows[0];
}

export async function upsertChatSettings(chatId: number, row: ChatSettingsRow) {
  await pool.query(
    `INSERT INTO chat_settings (
      chat_id, summary_admin_only, default_message_count, video_enabled, gallery_enabled, media_cooldown_seconds, sarcasm_level, mention_enabled, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (chat_id) DO UPDATE SET
      summary_admin_only = EXCLUDED.summary_admin_only,
      default_message_count = EXCLUDED.default_message_count,
      video_enabled = EXCLUDED.video_enabled,
      gallery_enabled = EXCLUDED.gallery_enabled,
      media_cooldown_seconds = EXCLUDED.media_cooldown_seconds,
      sarcasm_level = EXCLUDED.sarcasm_level,
      mention_enabled = EXCLUDED.mention_enabled,
      updated_at = now()`,
    [
      String(chatId),
      row.summary_admin_only,
      row.default_message_count,
      row.video_enabled,
      row.gallery_enabled,
      row.media_cooldown_seconds,
      row.sarcasm_level,
      row.mention_enabled,
    ],
  );
}

export async function deleteChatSettings(chatId: number) {
  await pool.query('DELETE FROM chat_settings WHERE chat_id = $1', [String(chatId)]);
}

export type VideoCacheEntry = {
  file_id: string;
  caption: string;
  width: number;
  height: number;
  duration: number;
};

export async function getVideoCache(sourceUrl: string, qualityKey: string): Promise<VideoCacheEntry | undefined> {
  if (config.VIDEO_CACHE_SIZE <= 0) return;
  const result = await pool.query<VideoCacheEntry>(`
    UPDATE video_cache SET last_used_at = now()
    WHERE source_url = $1 AND quality_key = $2
    RETURNING file_id, caption, width, height, duration`, [sourceUrl, qualityKey]);
  return result.rows[0];
}

export async function saveVideoCache(
  sourceUrl: string,
  qualityKey: string,
  entry: VideoCacheEntry,
) {
  if (config.VIDEO_CACHE_SIZE <= 0) return;
  await pool.query(`
    INSERT INTO video_cache (source_url, file_id, quality_key, caption, width, height, duration, created_at, last_used_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
    ON CONFLICT (source_url) DO UPDATE SET
      file_id = EXCLUDED.file_id,
      quality_key = EXCLUDED.quality_key,
      caption = EXCLUDED.caption,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      duration = EXCLUDED.duration,
      last_used_at = now()`,
  [sourceUrl, entry.file_id, qualityKey, entry.caption, entry.width, entry.height, entry.duration]);
  await pool.query(`
    WITH ranked AS (
      SELECT source_url, ROW_NUMBER() OVER (ORDER BY last_used_at DESC) AS rn
      FROM video_cache
    )
    DELETE FROM video_cache
    WHERE source_url IN (SELECT source_url FROM ranked WHERE rn > $1)`, [config.VIDEO_CACHE_SIZE]);
}

export async function deleteVideoCache(sourceUrl: string) {
  await pool.query('DELETE FROM video_cache WHERE source_url = $1', [sourceUrl]);
}

export async function saveMessage(chatId: number, message: ChatMessage) {
  await pool.query(`INSERT INTO messages (chat_id, message_id, author, text, sent_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (chat_id, message_id) DO UPDATE SET author = EXCLUDED.author, text = EXCLUDED.text`,
  [String(chatId), message.message_id, message.author, message.text, message.sent_at]);
}

export async function selectMessages(chatId: number, selection: Selection, beforeId: number, connection: pg.PoolClient) {
  const result = await connection.query<ChatMessage>(`
    SELECT message_id, author, text, sent_at FROM messages
    WHERE chat_id = $1 AND message_id < $2
      AND sent_at >= now() - ($3::int * interval '1 hour')
    ORDER BY sent_at DESC, message_id DESC LIMIT $4`,
  [String(chatId), beforeId, selection.kind === 'hours' ? selection.hours : config.RETENTION_DAYS * 24,
    selection.kind === 'count' ? selection.count : config.MAX_MESSAGE_COUNT]);
  return result.rows.reverse();
}

export async function claimSummary(chatId: number, connection: pg.PoolClient): Promise<boolean> {
  const result = await connection.query(`INSERT INTO summary_requests (chat_id, requested_at) VALUES ($1, now())
    ON CONFLICT (chat_id) DO UPDATE SET requested_at = now()
    WHERE summary_requests.requested_at <= now() - ($2::int * interval '1 second')
    RETURNING chat_id`, [String(chatId), config.SUMMARY_COOLDOWN_SECONDS]);
  return result.rowCount === 1;
}

export async function listKnownChatIds(): Promise<number[]> {
  const result = await pool.query<{ chat_id: string }>(
    `SELECT chat_id::text AS chat_id FROM messages
     UNION
     SELECT chat_id::text FROM chat_settings
     UNION
     SELECT chat_id::text FROM openai_usage`,
  );
  return result.rows
    .map((row) => Number(row.chat_id))
    .filter((id) => Number.isSafeInteger(id));
}

export async function hasChatMemberSnapshot(chatId: number, capturedOn: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM chat_member_snapshots WHERE chat_id = $1 AND captured_on = $2::date LIMIT 1`,
    [String(chatId), capturedOn],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function saveChatMemberSnapshot(chatId: number, capturedOn: string, memberCount: number) {
  await pool.query(
    `INSERT INTO chat_member_snapshots (chat_id, captured_on, member_count)
     VALUES ($1, $2::date, $3)
     ON CONFLICT (chat_id, captured_on) DO UPDATE SET member_count = EXCLUDED.member_count`,
    [String(chatId), capturedOn, memberCount],
  );
}

/** Latest known member count per chat (by captured_on). */
export async function getLatestChatMemberCounts(): Promise<Map<number, number>> {
  const result = await pool.query<{ chat_id: string; member_count: number }>(
    `SELECT DISTINCT ON (chat_id) chat_id::text AS chat_id, member_count
     FROM chat_member_snapshots
     ORDER BY chat_id, captured_on DESC`,
  );
  return new Map(result.rows.map((row) => [Number(row.chat_id), row.member_count]));
}

export async function getTotalLatestChatMembers(): Promise<number | undefined> {
  const result = await pool.query<{ total: string; chats: string }>(
    `SELECT COALESCE(SUM(member_count), 0)::text AS total, COUNT(*)::text AS chats
     FROM (
       SELECT DISTINCT ON (chat_id) member_count
       FROM chat_member_snapshots
       ORDER BY chat_id, captured_on DESC
     ) AS latest`,
  );
  const chats = Number(result.rows[0]?.chats) || 0;
  if (!chats) return;
  return Number(result.rows[0]?.total) || 0;
}

export async function cleanup() {
  await pool.query(`DELETE FROM messages WHERE sent_at < now() - ($1::int * interval '1 day')`, [config.RETENTION_DAYS]);
  await pool.query(
    `DELETE FROM summary_requests WHERE requested_at < now() - ($1::int * interval '1 day')`,
    [config.SUMMARY_REQUEST_RETENTION_DAYS],
  );
  await pool.query(
    `DELETE FROM openai_usage WHERE created_at < now() - ($1::int * interval '1 day')`,
    [config.USAGE_RETENTION_DAYS],
  );
  await pool.query(
    `DELETE FROM chat_member_snapshots WHERE captured_on < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - ($1::int * interval '1 day')`,
    [config.USAGE_RETENTION_DAYS],
  );
}

export async function deleteMessage(chatId: number, messageId: number) {
  await pool.query('DELETE FROM messages WHERE chat_id = $1 AND message_id = $2', [String(chatId), messageId]);
}

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
      message_thread_id INTEGER NULL,
      PRIMARY KEY (chat_id, message_id)
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_thread_id INTEGER NULL;
    CREATE INDEX IF NOT EXISTS messages_chat_time ON messages (chat_id, sent_at DESC, message_id DESC);
    CREATE INDEX IF NOT EXISTS messages_chat_thread_time
      ON messages (chat_id, message_thread_id, sent_at DESC, message_id DESC);
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
    ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS news_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS news_spheres TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS news_next_run_at TIMESTAMPTZ NULL;
    ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS news_last_sent_on DATE NULL;
    ALTER TABLE chat_settings ADD COLUMN IF NOT EXISTS auto_answer_enabled BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS chat_settings_news_due ON chat_settings (news_next_run_at)
      WHERE news_enabled;
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
  `);
}

export type OpenAiUsageKind = 'summary' | 'mention' | 'gif' | 'news' | 'auto_answer';

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
  newsRequests: number;
  autoAnswerRequests: number;
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
  newsRequests: 0,
  autoAnswerRequests: 0,
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
  news_requests: string;
  auto_answer_requests: string;
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
    newsRequests: Number(row.news_requests) || 0,
    autoAnswerRequests: Number(row.auto_answer_requests) || 0,
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
  COUNT(*) FILTER (WHERE kind = 'news')::text AS news_requests,
  COUNT(*) FILTER (WHERE kind = 'auto_answer')::text AS auto_answer_requests,
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
    news_requests: string;
    auto_answer_requests: string;
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
    news_requests: string;
    auto_answer_requests: string;
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
    news_requests: string;
    auto_answer_requests: string;
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
  news_enabled: boolean;
  news_spheres: string[];
  news_next_run_at: Date | string | null;
  news_last_sent_on: string | null;
  auto_answer_enabled: boolean;
};

export type DueNewsChat = {
  chatId: number;
  newsSpheres: string[];
};

export async function getChatSettingsRow(chatId: number): Promise<ChatSettingsRow | undefined> {
  const result = await pool.query<ChatSettingsRow>(
    `SELECT summary_admin_only, default_message_count, video_enabled, gallery_enabled, media_cooldown_seconds,
            sarcasm_level, mention_enabled, news_enabled, news_spheres, news_next_run_at, news_last_sent_on,
            auto_answer_enabled
     FROM chat_settings WHERE chat_id = $1`,
    [String(chatId)],
  );
  return result.rows[0];
}

export async function upsertChatSettings(chatId: number, row: ChatSettingsRow) {
  await pool.query(
    `INSERT INTO chat_settings (
      chat_id, summary_admin_only, default_message_count, video_enabled, gallery_enabled, media_cooldown_seconds,
      sarcasm_level, mention_enabled, news_enabled, news_spheres, auto_answer_enabled, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
    ON CONFLICT (chat_id) DO UPDATE SET
      summary_admin_only = EXCLUDED.summary_admin_only,
      default_message_count = EXCLUDED.default_message_count,
      video_enabled = EXCLUDED.video_enabled,
      gallery_enabled = EXCLUDED.gallery_enabled,
      media_cooldown_seconds = EXCLUDED.media_cooldown_seconds,
      sarcasm_level = EXCLUDED.sarcasm_level,
      mention_enabled = EXCLUDED.mention_enabled,
      news_enabled = EXCLUDED.news_enabled,
      news_spheres = EXCLUDED.news_spheres,
      auto_answer_enabled = EXCLUDED.auto_answer_enabled,
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
      row.news_enabled,
      row.news_spheres,
      row.auto_answer_enabled,
    ],
  );
}

export async function listDueNewsChats(now: Date): Promise<DueNewsChat[]> {
  const result = await pool.query<{ chat_id: string; news_spheres: string[] }>(
    `SELECT chat_id::text AS chat_id, news_spheres
     FROM chat_settings
     WHERE news_enabled = true
       AND cardinality(news_spheres) > 0
       AND news_next_run_at IS NOT NULL
       AND news_next_run_at <= $1::timestamptz
       AND (news_last_sent_on IS NULL OR news_last_sent_on < ($1 AT TIME ZONE 'Europe/Moscow')::date)`,
    [now],
  );
  return result.rows.map((row) => ({
    chatId: Number(row.chat_id),
    newsSpheres: row.news_spheres ?? [],
  }));
}

/**
 * Atomically claim a due news send with a short in-progress lease on news_next_run_at.
 * Does not mark the day as sent; caller must markNewsSent or soft-reschedule after send.
 */
export async function claimNewsSend(
  chatId: number,
  moscowDate: string,
  leaseUntil: Date,
  now: Date,
): Promise<DueNewsChat | undefined> {
  const result = await pool.query<{ chat_id: string; news_spheres: string[] }>(
    `UPDATE chat_settings
     SET news_next_run_at = $3::timestamptz, updated_at = now()
     WHERE chat_id = $1
       AND news_enabled = true
       AND cardinality(news_spheres) > 0
       AND news_next_run_at IS NOT NULL
       AND news_next_run_at <= $4::timestamptz
       AND (news_last_sent_on IS NULL OR news_last_sent_on < $2::date)
     RETURNING chat_id::text AS chat_id, news_spheres`,
    [String(chatId), moscowDate, leaseUntil, now],
  );
  const row = result.rows[0];
  if (!row) return;
  return { chatId: Number(row.chat_id), newsSpheres: row.news_spheres ?? [] };
}

/** Mark today's send and schedule the next day's window in one update. */
export async function markNewsSent(chatId: number, moscowDate: string, nextRunAt: Date) {
  await pool.query(
    `UPDATE chat_settings
     SET news_last_sent_on = $2::date,
         news_next_run_at = $3::timestamptz,
         updated_at = now()
     WHERE chat_id = $1`,
    [String(chatId), moscowDate, nextRunAt],
  );
}

/** Failsafe after a delivered post: block same-day reclaim even if next_run update failed. */
export async function markNewsSentDay(chatId: number, moscowDate: string) {
  await pool.query(
    `UPDATE chat_settings
     SET news_last_sent_on = $2::date, updated_at = now()
     WHERE chat_id = $1`,
    [String(chatId), moscowDate],
  );
}

export async function rescheduleNewsRun(chatId: number, nextRunAt: Date | null) {
  await pool.query(
    `UPDATE chat_settings
     SET news_next_run_at = $2::timestamptz, updated_at = now()
     WHERE chat_id = $1`,
    [String(chatId), nextRunAt],
  );
}

/** Stop daily news for a chat that can no longer receive messages (403 / kicked / gone). */
export async function disableNewsForChat(chatId: number) {
  await pool.query(
    `UPDATE chat_settings
     SET news_enabled = false, news_next_run_at = NULL, updated_at = now()
     WHERE chat_id = $1`,
    [String(chatId)],
  );
}

export async function deleteChatSettings(chatId: number) {
  await pool.query('DELETE FROM chat_settings WHERE chat_id = $1', [String(chatId)]);
}

export type PendingAutoAnswerStatus =
  | 'pending'
  | 'claimed'
  | 'sending'
  | 'answered'
  | 'cancelled'
  | 'failed';

/** Statuses that human engagement / settings-off may still cancel. */
export const CANCELABLE_AUTO_ANSWER_STATUSES = ['pending', 'claimed', 'sending'] as const;

export function isCancelableAutoAnswerStatus(status: string): boolean {
  return (CANCELABLE_AUTO_ANSWER_STATUSES as readonly string[]).includes(status);
}

const CANCELABLE_STATUS_SQL = `'pending', 'claimed', 'sending'`;

export type PendingAutoAnswer = {
  chatId: number;
  messageId: number;
  messageThreadId: number | null;
  author: string;
  questionText: string;
  askerUserId: number | null;
  createdAt: Date;
  dueAt: Date;
  status: PendingAutoAnswerStatus;
  claimedUntil: Date | null;
  answerText: string | null;
};

type PendingAutoAnswerRow = {
  chat_id: string;
  message_id: number;
  message_thread_id: number | null;
  author: string;
  question_text: string;
  asker_user_id: string | null;
  created_at: Date;
  due_at: Date;
  status: string;
  claimed_until: Date | null;
  answer_text: string | null;
};

function mapPendingAutoAnswer(row: PendingAutoAnswerRow): PendingAutoAnswer {
  return {
    chatId: Number(row.chat_id),
    messageId: row.message_id,
    messageThreadId: row.message_thread_id,
    author: row.author,
    questionText: row.question_text,
    askerUserId: row.asker_user_id == null ? null : Number(row.asker_user_id),
    createdAt: new Date(row.created_at),
    dueAt: new Date(row.due_at),
    status: row.status as PendingAutoAnswerStatus,
    claimedUntil: row.claimed_until ? new Date(row.claimed_until) : null,
    answerText: row.answer_text ?? null,
  };
}

const PENDING_AUTO_ANSWER_RETURNING = `
  chat_id::text AS chat_id, message_id, message_thread_id, author, question_text,
  asker_user_id::text AS asker_user_id, created_at, due_at, status, claimed_until, answer_text
`;

export async function enqueuePendingAutoAnswer(row: {
  chatId: number;
  messageId: number;
  messageThreadId: number | null;
  author: string;
  questionText: string;
  askerUserId: number | null;
  createdAt: Date;
  dueAt: Date;
}): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO pending_auto_answers (
      chat_id, message_id, message_thread_id, author, question_text, asker_user_id,
      created_at, due_at, status, claimed_until
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NULL)
    ON CONFLICT (chat_id, message_id) DO NOTHING`,
    [
      String(row.chatId),
      row.messageId,
      row.messageThreadId,
      row.author,
      row.questionText,
      row.askerUserId == null ? null : String(row.askerUserId),
      row.createdAt,
      row.dueAt,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listDuePendingAutoAnswers(now: Date, limit = 50): Promise<PendingAutoAnswer[]> {
  const result = await pool.query<PendingAutoAnswerRow>(
    `SELECT ${PENDING_AUTO_ANSWER_RETURNING}
     FROM pending_auto_answers
     WHERE due_at <= $1::timestamptz
       AND (
         status = 'pending'
         OR (
           status IN ('claimed', 'sending')
           AND claimed_until IS NOT NULL
           AND claimed_until <= $1::timestamptz
         )
       )
     ORDER BY due_at ASC
     LIMIT $2`,
    [now, limit],
  );
  return result.rows.map(mapPendingAutoAnswer);
}

export async function claimPendingAutoAnswer(
  chatId: number,
  messageId: number,
  leaseUntil: Date,
  now: Date,
): Promise<PendingAutoAnswer | undefined> {
  const result = await pool.query<PendingAutoAnswerRow>(
    `UPDATE pending_auto_answers
     SET status = 'claimed', claimed_until = $3::timestamptz
     WHERE chat_id = $1
       AND message_id = $2
       AND due_at <= $4::timestamptz
       AND (
         status = 'pending'
         OR (
           status IN ('claimed', 'sending')
           AND claimed_until IS NOT NULL
           AND claimed_until <= $4::timestamptz
         )
       )
     RETURNING ${PENDING_AUTO_ANSWER_RETURNING}`,
    [String(chatId), messageId, leaseUntil, now],
  );
  const row = result.rows[0];
  return row ? mapPendingAutoAnswer(row) : undefined;
}

export async function markPendingAutoAnswerStatus(
  chatId: number,
  messageId: number,
  status: 'answered' | 'cancelled' | 'failed',
) {
  await pool.query(
    `UPDATE pending_auto_answers
     SET status = $3, claimed_until = NULL
     WHERE chat_id = $1 AND message_id = $2 AND status IN (${CANCELABLE_STATUS_SQL})`,
    [String(chatId), messageId, status],
  );
}

/** Persist model output while this claim lease still owns the row. */
export async function persistPendingAutoAnswerText(
  chatId: number,
  messageId: number,
  claimedUntil: Date,
  answerText: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE pending_auto_answers
     SET answer_text = $4
     WHERE chat_id = $1
       AND message_id = $2
       AND status = 'claimed'
       AND claimed_until = $3::timestamptz`,
    [String(chatId), messageId, claimedUntil, answerText],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Atomically claim → sending before Telegram send, bound to this claim lease.
 * `sending` stays cancelable; terminal `answered` is set only after ACK.
 */
export async function markPendingAutoAnswerSending(
  chatId: number,
  messageId: number,
  claimedUntil: Date,
): Promise<string | undefined> {
  const result = await pool.query<{ answer_text: string }>(
    `UPDATE pending_auto_answers
     SET status = 'sending'
     WHERE chat_id = $1
       AND message_id = $2
       AND status = 'claimed'
       AND claimed_until = $3::timestamptz
       AND answer_text IS NOT NULL
     RETURNING answer_text`,
    [String(chatId), messageId, claimedUntil],
  );
  return result.rows[0]?.answer_text;
}

/** Terminal success: only after Telegram send ACK, while still in cancelable `sending`. */
export async function markSendingAutoAnswerAnswered(
  chatId: number,
  messageId: number,
  claimedUntil: Date,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE pending_auto_answers
     SET status = 'answered', claimed_until = NULL
     WHERE chat_id = $1
       AND message_id = $2
       AND status = 'sending'
       AND claimed_until = $3::timestamptz`,
    [String(chatId), messageId, claimedUntil],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * After a transient send failure, re-queue for send-only retry if still `sending`
 * (human cancel / settings-off become cancelled and reclaim is a no-op).
 */
export async function reclaimSendingAutoAnswerForSendRetry(
  chatId: number,
  messageId: number,
  claimedUntil: Date,
  leaseUntil: Date,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE pending_auto_answers
     SET status = 'claimed', claimed_until = $4::timestamptz
     WHERE chat_id = $1
       AND message_id = $2
       AND status = 'sending'
       AND claimed_until = $3::timestamptz
       AND answer_text IS NOT NULL`,
    [String(chatId), messageId, claimedUntil, leaseUntil],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Fail-closed after permanent delivery error while still in `sending`. */
export async function markSendingAutoAnswerFailed(
  chatId: number,
  messageId: number,
  claimedUntil: Date,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE pending_auto_answers
     SET status = 'failed', claimed_until = NULL
     WHERE chat_id = $1
       AND message_id = $2
       AND status = 'sending'
       AND claimed_until = $3::timestamptz`,
    [String(chatId), messageId, claimedUntil],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Fail/cancel while still holding this specific claim lease (claimed only). */
export async function markPendingAutoAnswerStatusWithClaim(
  chatId: number,
  messageId: number,
  claimedUntil: Date,
  status: 'cancelled' | 'failed',
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE pending_auto_answers
     SET status = $4, claimed_until = NULL
     WHERE chat_id = $1
       AND message_id = $2
       AND status = 'claimed'
       AND claimed_until = $3::timestamptz`,
    [String(chatId), messageId, claimedUntil, status],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Cancel pending/claimed/sending rows that a later human message engages with. */
export async function cancelPendingAutoAnswersForScope(params: {
  chatId: number;
  replyToMessageId?: number;
  messageThreadId?: number | null;
  isForum: boolean;
}) {
  const { chatId, replyToMessageId, messageThreadId, isForum } = params;
  if (replyToMessageId != null) {
    await pool.query(
      `UPDATE pending_auto_answers
       SET status = 'cancelled', claimed_until = NULL
       WHERE chat_id = $1 AND message_id = $2 AND status IN (${CANCELABLE_STATUS_SQL})`,
      [String(chatId), replyToMessageId],
    );
  }
  if (isForum) {
    await pool.query(
      `UPDATE pending_auto_answers
       SET status = 'cancelled', claimed_until = NULL
       WHERE chat_id = $1
         AND message_thread_id IS NOT DISTINCT FROM $2
         AND status IN (${CANCELABLE_STATUS_SQL})`,
      [String(chatId), messageThreadId ?? null],
    );
    return;
  }
  await pool.query(
    `UPDATE pending_auto_answers
     SET status = 'cancelled', claimed_until = NULL
     WHERE chat_id = $1 AND status IN (${CANCELABLE_STATUS_SQL})`,
    [String(chatId)],
  );
}

export async function cancelAllPendingAutoAnswersForChat(chatId: number) {
  await pool.query(
    `UPDATE pending_auto_answers
     SET status = 'cancelled', claimed_until = NULL
     WHERE chat_id = $1 AND status IN (${CANCELABLE_STATUS_SQL})`,
    [String(chatId)],
  );
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
  await pool.query(`INSERT INTO messages (chat_id, message_id, author, text, sent_at, message_thread_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (chat_id, message_id) DO UPDATE SET
      author = EXCLUDED.author,
      text = EXCLUDED.text,
      message_thread_id = EXCLUDED.message_thread_id`,
  [
    String(chatId),
    message.message_id,
    message.author,
    message.text,
    message.sent_at,
    message.message_thread_id ?? null,
  ]);
}

/** Preceding lines for auto-answer OpenAI context (newest-first SQL, returned chronological). */
export async function selectPrecedingMessagesForAutoAnswer(params: {
  chatId: number;
  questionMessageId: number;
  questionCreatedAt: Date;
  messageThreadId: number | null;
  lookbackMinutes: number;
  maxMessages: number;
}): Promise<ChatMessage[]> {
  if (params.maxMessages <= 0) return [];
  const result = await pool.query<ChatMessage>(`
    SELECT message_id, author, text, sent_at, message_thread_id
    FROM messages
    WHERE chat_id = $1
      AND message_id < $2
      AND sent_at >= $3::timestamptz - ($4::int * interval '1 minute')
      AND message_thread_id IS NOT DISTINCT FROM $5
    ORDER BY sent_at DESC, message_id DESC
    LIMIT $6`,
  [
    String(params.chatId),
    params.questionMessageId,
    params.questionCreatedAt,
    params.lookbackMinutes,
    params.messageThreadId,
    params.maxMessages,
  ]);
  return result.rows.reverse();
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
  await pool.query(
    `DELETE FROM pending_auto_answers
     WHERE status IN ('answered', 'cancelled', 'failed')
       AND created_at < now() - ($1::int * interval '1 day')`,
    [config.RETENTION_DAYS],
  );
}

export async function deleteMessage(chatId: number, messageId: number) {
  await pool.query('DELETE FROM messages WHERE chat_id = $1 AND message_id = $2', [String(chatId), messageId]);
}

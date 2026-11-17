import pg from 'pg';
import { config } from '../config.js';
import type { ChatMessage, Selection } from '../summary/summary.js';

export const pool = new pg.Pool({
  ...(config.DATABASE_URL ? { connectionString: config.DATABASE_URL } : {}),
  max: config.PG_POOL_MAX,
  connectionTimeoutMillis: config.PG_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: config.PG_IDLE_TIMEOUT_MS,
  statement_timeout: config.PG_STATEMENT_TIMEOUT_MS,
});
pool.on('error', () => console.error('Postgres connection error'));

export type OpenAiUsageKind = 'summary' | 'mention' | 'gif' | 'news' | 'auto_answer' | 'personalization';

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
  personalizationRequests: number;
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
  personalizationRequests: 0,
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
  personalization_requests: string;
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
    personalizationRequests: Number(row.personalization_requests) || 0,
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
  COUNT(*) FILTER (WHERE kind = 'personalization')::text AS personalization_requests,
  COALESCE(SUM(prompt_tokens), 0)::text AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0)::text AS completion_tokens,
  COALESCE(SUM(image_count), 0)::text AS image_count,
  COALESCE(SUM(estimated_cost_usd), 0)::text AS estimated_cost_usd
`;

type UsageTotalsRow = {
  requests: string;
  summary_requests: string;
  mention_requests: string;
  gif_requests: string;
  news_requests: string;
  auto_answer_requests: string;
  personalization_requests: string;
  prompt_tokens: string;
  completion_tokens: string;
  image_count: string;
  estimated_cost_usd: string;
};

export async function getOpenAiUsageTotals(chatId: number, since?: Date): Promise<OpenAiUsageTotals> {
  const result = await pool.query<UsageTotalsRow>(
    `SELECT ${USAGE_TOTALS_SELECT}
     FROM openai_usage
     WHERE chat_id = $1
       AND ($2::timestamptz IS NULL OR created_at >= $2)`,
    [String(chatId), since ?? null],
  );
  return mapUsageTotals(result.rows[0]);
}

export async function getGlobalOpenAiUsageTotals(since?: Date): Promise<OpenAiUsageTotals> {
  const result = await pool.query<UsageTotalsRow>(
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
  const result = await pool.query<UsageTotalsRow & { chat_id: string }>(
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
  response_tone: string;
  mention_enabled: boolean;
  news_enabled: boolean;
  news_spheres: string[];
  news_next_run_at: Date | string | null;
  news_last_sent_on: string | null;
  auto_answer_enabled: boolean;
  personalization_enabled: boolean;
  /** Present on reads; upsert ignores this field (scheduler owns last_run_on). */
  personalization_last_run_on?: string | null;
};

export type DueNewsChat = {
  chatId: number;
  newsSpheres: string[];
};

export async function getChatSettingsRow(chatId: number): Promise<ChatSettingsRow | undefined> {
  const result = await pool.query<ChatSettingsRow>(
    `SELECT summary_admin_only, default_message_count, video_enabled, gallery_enabled, media_cooldown_seconds,
            sarcasm_level, response_tone, mention_enabled, news_enabled, news_spheres, news_next_run_at, news_last_sent_on,
            auto_answer_enabled, personalization_enabled, personalization_last_run_on
     FROM chat_settings WHERE chat_id = $1`,
    [String(chatId)],
  );
  return result.rows[0];
}

export async function upsertChatSettings(chatId: number, row: ChatSettingsRow) {
  await pool.query(
    `INSERT INTO chat_settings (
      chat_id, summary_admin_only, default_message_count, video_enabled, gallery_enabled, media_cooldown_seconds,
      sarcasm_level, response_tone, mention_enabled, news_enabled, news_spheres, auto_answer_enabled,
      personalization_enabled, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
    ON CONFLICT (chat_id) DO UPDATE SET
      summary_admin_only = EXCLUDED.summary_admin_only,
      default_message_count = EXCLUDED.default_message_count,
      video_enabled = EXCLUDED.video_enabled,
      gallery_enabled = EXCLUDED.gallery_enabled,
      media_cooldown_seconds = EXCLUDED.media_cooldown_seconds,
      sarcasm_level = EXCLUDED.sarcasm_level,
      response_tone = EXCLUDED.response_tone,
      mention_enabled = EXCLUDED.mention_enabled,
      news_enabled = EXCLUDED.news_enabled,
      news_spheres = EXCLUDED.news_spheres,
      auto_answer_enabled = EXCLUDED.auto_answer_enabled,
      personalization_enabled = EXCLUDED.personalization_enabled,
      updated_at = now()`,
    [
      String(chatId),
      row.summary_admin_only,
      row.default_message_count,
      row.video_enabled,
      row.gallery_enabled,
      row.media_cooldown_seconds,
      row.sarcasm_level,
      row.response_tone,
      row.mention_enabled,
      row.news_enabled,
      row.news_spheres,
      row.auto_answer_enabled,
      row.personalization_enabled,
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

/** Insert default settings if missing so personalization (default ON) can be scheduled. */
export async function ensureChatSettingsDefaults(chatId: number) {
  await pool.query(
    `INSERT INTO chat_settings (
      chat_id, summary_admin_only, default_message_count, video_enabled, gallery_enabled,
      media_cooldown_seconds, sarcasm_level, response_tone, mention_enabled, news_enabled,
      news_spheres, auto_answer_enabled, personalization_enabled, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'gentleman', true, false, '{}', false, true, now())
    ON CONFLICT (chat_id) DO NOTHING`,
    [
      String(chatId),
      config.SUMMARY_ADMIN_ONLY === 'true',
      config.DEFAULT_MESSAGE_COUNT,
      config.VIDEO_ENABLED === 'true',
      config.GALLERY_ENABLED === 'true',
      config.MEDIA_COOLDOWN_SECONDS ?? config.VIDEO_COOLDOWN_SECONDS,
      config.SUMMARY_SARCASM_PERCENT,
    ],
  );
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
  await pool.query(`INSERT INTO messages (chat_id, message_id, author, text, sent_at, message_thread_id, is_bot, author_user_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (chat_id, message_id) DO UPDATE SET
      author = EXCLUDED.author,
      text = EXCLUDED.text,
      message_thread_id = EXCLUDED.message_thread_id,
      is_bot = EXCLUDED.is_bot,
      author_user_id = EXCLUDED.author_user_id`,
  [
    String(chatId),
    message.message_id,
    message.author,
    message.text,
    message.sent_at,
    message.message_thread_id ?? null,
    message.is_bot ?? false,
    message.author_user_id ?? null,
  ]);
}

/** Persist a successfully sent bot text/caption reply for mention/auto-answer context. */
export async function persistBotMessage(
  chatId: number,
  sentMessage: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    message_thread_id?: number;
  },
  authorLabel: string,
) {
  const text = (sentMessage.text ?? sentMessage.caption ?? '').trim();
  if (!text) return;
  await saveMessage(chatId, {
    message_id: sentMessage.message_id,
    author: authorLabel,
    text,
    sent_at: new Date(sentMessage.date * 1000),
    message_thread_id: sentMessage.message_thread_id ?? null,
    is_bot: true,
  });
}

/** Preceding lines for OpenAI context (newest-first SQL, returned chronological). */
export async function selectPrecedingMessages(params: {
  chatId: number;
  /** Anchor message id — load rows with message_id strictly less than this. */
  beforeMessageId: number;
  /** Lookback window is measured from this instant. */
  beforeSentAt: Date;
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
    params.beforeMessageId,
    params.beforeSentAt,
    params.lookbackMinutes,
    params.messageThreadId,
    params.maxMessages,
  ]);
  return result.rows.reverse();
}

/** @deprecated Prefer selectPrecedingMessages — kept for existing call sites/tests. */
export async function selectPrecedingMessagesForAutoAnswer(params: {
  chatId: number;
  questionMessageId: number;
  questionCreatedAt: Date;
  messageThreadId: number | null;
  lookbackMinutes: number;
  maxMessages: number;
}): Promise<ChatMessage[]> {
  return selectPrecedingMessages({
    chatId: params.chatId,
    beforeMessageId: params.questionMessageId,
    beforeSentAt: params.questionCreatedAt,
    messageThreadId: params.messageThreadId,
    lookbackMinutes: params.lookbackMinutes,
    maxMessages: params.maxMessages,
  });
}

export async function selectMessages(chatId: number, selection: Selection, beforeId: number, connection: pg.PoolClient) {
  const result = await connection.query<ChatMessage>(`
    SELECT message_id, author, text, sent_at FROM messages
    WHERE chat_id = $1 AND message_id < $2
      AND is_bot = false
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

/** Latest known member count for one chat, or undefined if none. */
export async function getLatestMemberCount(chatId: number): Promise<number | undefined> {
  const result = await pool.query<{ member_count: number }>(
    `SELECT member_count
     FROM chat_member_snapshots
     WHERE chat_id = $1
     ORDER BY captured_on DESC
     LIMIT 1`,
    [String(chatId)],
  );
  const count = result.rows[0]?.member_count;
  return typeof count === 'number' ? count : undefined;
}

export type ChatParticipantRow = {
  chatId: number;
  userId: number;
  username: string | null;
  displayName: string;
  characteristic: string | null;
  characteristicUpdatedAt: Date | null;
  characteristicSourceUntil: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  updatedAt: Date;
};

type ChatParticipantDbRow = {
  chat_id: string;
  user_id: string;
  username: string | null;
  display_name: string;
  characteristic: string | null;
  characteristic_updated_at: Date | null;
  characteristic_source_until: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  updated_at: Date;
};

function mapChatParticipant(row: ChatParticipantDbRow): ChatParticipantRow {
  return {
    chatId: Number(row.chat_id),
    userId: Number(row.user_id),
    username: row.username,
    displayName: row.display_name,
    characteristic: row.characteristic,
    characteristicUpdatedAt: row.characteristic_updated_at,
    characteristicSourceUntil: row.characteristic_source_until,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertChatParticipant(params: {
  chatId: number;
  userId: number;
  username?: string | null;
  displayName: string;
  seenAt?: Date;
}) {
  const seenAt = params.seenAt ?? new Date();
  await pool.query(
    `INSERT INTO chat_participants (
      chat_id, user_id, username, display_name, first_seen_at, last_seen_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $5, $5)
    ON CONFLICT (chat_id, user_id) DO UPDATE SET
      username = COALESCE(EXCLUDED.username, chat_participants.username),
      display_name = EXCLUDED.display_name,
      last_seen_at = GREATEST(chat_participants.last_seen_at, EXCLUDED.last_seen_at),
      updated_at = now()`,
    [
      String(params.chatId),
      String(params.userId),
      params.username ?? null,
      params.displayName,
      seenAt,
    ],
  );
}

export async function getChatParticipant(
  chatId: number,
  userId: number,
): Promise<ChatParticipantRow | undefined> {
  const result = await pool.query<ChatParticipantDbRow>(
    `SELECT chat_id::text AS chat_id, user_id::text AS user_id, username, display_name, characteristic,
            characteristic_updated_at, characteristic_source_until, first_seen_at, last_seen_at, updated_at
     FROM chat_participants
     WHERE chat_id = $1 AND user_id = $2`,
    [String(chatId), String(userId)],
  );
  const row = result.rows[0];
  return row ? mapChatParticipant(row) : undefined;
}

export async function listChatParticipants(
  chatId: number,
  limit = config.PERSONALIZATION_MAX_USERS_PER_CHAT,
): Promise<ChatParticipantRow[]> {
  const result = await pool.query<ChatParticipantDbRow>(
    `SELECT chat_id::text AS chat_id, user_id::text AS user_id, username, display_name, characteristic,
            characteristic_updated_at, characteristic_source_until, first_seen_at, last_seen_at, updated_at
     FROM chat_participants
     WHERE chat_id = $1
     ORDER BY last_seen_at DESC
     LIMIT $2`,
    [String(chatId), limit],
  );
  return result.rows.map(mapChatParticipant);
}

/** Distinct chats that already have ≥1 non-empty characteristic, newest first. */
export async function listChatsWithCharacteristicsForStats(maxChats = 30): Promise<number[]> {
  const result = await pool.query<{ chat_id: string }>(
    `SELECT chat_id::text AS chat_id
     FROM chat_participants
     WHERE characteristic IS NOT NULL AND btrim(characteristic) <> ''
     GROUP BY chat_id
     ORDER BY MAX(characteristic_updated_at) DESC NULLS LAST
     LIMIT $1`,
    [maxChats],
  );
  return result.rows.map((row) => Number(row.chat_id));
}

/** Participants with a non-empty characteristic, most recently seen first. */
export async function listChatParticipantsWithCharacteristics(
  chatId: number,
  limit = config.PERSONALIZATION_MAX_USERS_PER_CHAT,
): Promise<ChatParticipantRow[]> {
  const result = await pool.query<ChatParticipantDbRow>(
    `SELECT chat_id::text AS chat_id, user_id::text AS user_id, username, display_name, characteristic,
            characteristic_updated_at, characteristic_source_until, first_seen_at, last_seen_at, updated_at
     FROM chat_participants
     WHERE chat_id = $1
       AND characteristic IS NOT NULL AND btrim(characteristic) <> ''
     ORDER BY last_seen_at DESC
     LIMIT $2`,
    [String(chatId), limit],
  );
  return result.rows.map(mapChatParticipant);
}

export async function updateParticipantCharacteristic(params: {
  chatId: number;
  userId: number;
  characteristic: string;
  sourceUntil: Date;
}) {
  await pool.query(
    `UPDATE chat_participants
     SET characteristic = $3,
         characteristic_updated_at = now(),
         characteristic_source_until = $4,
         updated_at = now()
     WHERE chat_id = $1 AND user_id = $2`,
    [String(params.chatId), String(params.userId), params.characteristic, params.sourceUntil],
  );
}

export type PersonalizationMessage = {
  authorUserId: number;
  displayName: string;
  text: string;
  sentAt: Date;
};

/** Newest-first rows → chronological order for transcripts. */
export function chronologicalFromNewestFirst<T>(rows: T[]): T[] {
  return rows.slice().reverse();
}

/** Non-bot messages with author_user_id in [since, until]: latest N, returned chronological. */
export async function listMessagesForPersonalization(params: {
  chatId: number;
  since: Date;
  until: Date;
  maxMessages?: number;
}): Promise<PersonalizationMessage[]> {
  const maxMessages = params.maxMessages ?? config.PERSONALIZATION_MAX_MESSAGES;
  const result = await pool.query<{
    author_user_id: string;
    author: string;
    text: string;
    sent_at: Date;
  }>(
    `SELECT author_user_id::text AS author_user_id, author, text, sent_at
     FROM messages
     WHERE chat_id = $1
       AND is_bot = false
       AND author_user_id IS NOT NULL
       AND sent_at >= $2::timestamptz
       AND sent_at < $3::timestamptz
     ORDER BY sent_at DESC, message_id DESC
     LIMIT $4`,
    [String(params.chatId), params.since, params.until, maxMessages],
  );
  return chronologicalFromNewestFirst(result.rows).map((row) => ({
    authorUserId: Number(row.author_user_id),
    displayName: row.author,
    text: row.text,
    sentAt: row.sent_at,
  }));
}

export async function listDuePersonalizationChats(moscowDate: string): Promise<number[]> {
  const result = await pool.query<{ chat_id: string }>(
    `SELECT chat_id::text AS chat_id
     FROM chat_settings
     WHERE personalization_enabled = true
       AND (personalization_last_run_on IS NULL OR personalization_last_run_on < $1::date)`,
    [moscowDate],
  );
  return result.rows.map((row) => Number(row.chat_id));
}

/** All chats with personalization enabled (ignores last_run_on). */
export async function listEnabledPersonalizationChats(): Promise<number[]> {
  const result = await pool.query<{ chat_id: string }>(
    `SELECT chat_id::text AS chat_id
     FROM chat_settings
     WHERE personalization_enabled = true`,
  );
  return result.rows.map((row) => Number(row.chat_id));
}

/**
 * Atomically claim today's personalization run by setting last_run_on.
 * Returns true if this process owns the run.
 */
export async function claimPersonalizationRun(chatId: number, moscowDate: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE chat_settings
     SET personalization_last_run_on = $2::date, updated_at = now()
     WHERE chat_id = $1
       AND personalization_enabled = true
       AND (personalization_last_run_on IS NULL OR personalization_last_run_on < $2::date)
     RETURNING chat_id`,
    [String(chatId), moscowDate],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * Unconditionally set last_run_on (manual path after soft-skip/success).
 * Does not require last_run_on to be null/older.
 */
export async function markPersonalizationRun(chatId: number, moscowDate: string): Promise<void> {
  await pool.query(
    `UPDATE chat_settings
     SET personalization_last_run_on = $2::date, updated_at = now()
     WHERE chat_id = $1
       AND personalization_enabled = true`,
    [String(chatId), moscowDate],
  );
}

/** Clear today's claim so a failed run can retry on the next tick. */
export async function clearPersonalizationRunClaim(chatId: number, moscowDate: string) {
  await pool.query(
    `UPDATE chat_settings
     SET personalization_last_run_on = NULL, updated_at = now()
     WHERE chat_id = $1
       AND personalization_last_run_on = $2::date`,
    [String(chatId), moscowDate],
  );
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

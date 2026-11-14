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
  `);
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

export async function cleanup() {
  await pool.query(`DELETE FROM messages WHERE sent_at < now() - ($1::int * interval '1 day')`, [config.RETENTION_DAYS]);
  await pool.query(
    `DELETE FROM summary_requests WHERE requested_at < now() - ($1::int * interval '1 day')`,
    [config.SUMMARY_REQUEST_RETENTION_DAYS],
  );
}

export async function deleteMessage(chatId: number, messageId: number) {
  await pool.query('DELETE FROM messages WHERE chat_id = $1 AND message_id = $2', [String(chatId), messageId]);
}

// Run against a disposable database only: npm run test:integration
import assert from 'node:assert/strict';
import {
  pool,
  saveMessage,
  persistBotMessage,
  selectMessages,
  selectPrecedingMessages,
  claimSummary,
  deleteMessage,
  cleanup,
} from '../src/core/db.js';
import { migrate } from '../src/core/migrate.js';

const chatA = -987654321001;
const chatB = -987654321002;
try {
  await migrate();

  const expectedTables = [
    'chat_member_snapshots',
    'chat_memory',
    'chat_settings',
    'messages',
    'openai_usage',
    'pending_auto_answers',
    'schema_migrations',
    'summary_requests',
    'video_cache',
  ];
  const tables = await pool.query<{ relname: string }>(
    `SELECT relname FROM pg_class
     WHERE relkind = 'r'
       AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
       AND relname = ANY($1::text[])`,
    [expectedTables],
  );
  assert.deepEqual(tables.rows.map((r) => r.relname).sort(), expectedTables);
  const absent = await pool.query<{ relname: string }>(
    `SELECT relname FROM pg_class
     WHERE relkind = 'r'
       AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
       AND relname = 'chat_participants'`,
  );
  assert.equal(absent.rows.length, 0);
  const applied = await pool.query<{ id: string }>(
    'SELECT id FROM schema_migrations ORDER BY id',
  );
  assert.deepEqual(applied.rows.map((r) => r.id), ['001_baseline', '002_drop_personalization', '003_chat_memory']);

  await migrate();
  const appliedAgain = await pool.query<{ id: string }>(
    'SELECT id FROM schema_migrations ORDER BY id',
  );
  assert.deepEqual(appliedAgain.rows.map((r) => r.id), ['001_baseline', '002_drop_personalization', '003_chat_memory']);

  await pool.query('DELETE FROM messages WHERE chat_id = ANY($1::bigint[])', [[chatA, chatB]]);
  await pool.query('DELETE FROM summary_requests WHERE chat_id = ANY($1::bigint[])', [[chatA, chatB]]);
  const row = (id: number, text: string, ageHours = 0, threadId: number | null = null, isBot = false) => ({
    message_id: id,
    author: isBot ? '@summary_bot' : 'Тест',
    text,
    sent_at: new Date(Date.now() - ageHours * 3600000),
    message_thread_id: threadId,
    is_bot: isBot,
  });
  await saveMessage(chatA, row(1, 'old', 48));
  await saveMessage(chatA, row(2, 'original', 1));
  await saveMessage(chatA, row(2, 'edited', 1));
  await saveMessage(chatA, row(3, 'future command boundary'));
  await saveMessage(chatB, row(1, 'other chat'));
  await saveMessage(chatA, row(4, 'expired', 24 * 31));
  await saveMessage(chatA, row(10, 'topic-a-1', 0.1, 7));
  await saveMessage(chatA, row(11, 'topic-b', 0.05, 8));
  await saveMessage(chatA, row(12, 'topic-a-2', 0.02, 7));
  await saveMessage(chatA, row(13, 'bot reply in topic', 0.01, 7, true));
  await saveMessage(chatA, row(15, 'question-in-topic', 0, 7));
  await persistBotMessage(
    chatA,
    { message_id: 20, date: Math.floor(Date.now() / 1000), text: '  persisted bot text  ', message_thread_id: 7 },
    '@summary_bot',
  );
  await persistBotMessage(
    chatA,
    { message_id: 21, date: Math.floor(Date.now() / 1000), text: '   ', message_thread_id: 7 },
    '@summary_bot',
  );
  const connection = await pool.connect();
  try {
    const rows = await selectMessages(chatA, { kind: 'count', count: 10 }, 3, connection);
    assert.deepEqual(rows.map((r) => r.text), ['old', 'edited']);
    const recent = await selectMessages(chatA, { kind: 'hours', hours: 24 }, 3, connection);
    assert.deepEqual(recent.map((r) => r.text), ['edited']);
    // Bot rows are excluded from summary/gif selectMessages.
    const withBotBoundary = await selectMessages(chatA, { kind: 'count', count: 20 }, 25, connection);
    assert.equal(withBotBoundary.some((r) => r.text === 'bot reply in topic'), false);
    assert.equal(withBotBoundary.some((r) => r.text === 'persisted bot text'), false);
    assert.equal(await claimSummary(chatA, connection), true);
    assert.equal(await claimSummary(chatA, connection), false);
    assert.equal(await claimSummary(chatB, connection), true);
    await connection.query('SELECT pg_advisory_lock($1::bigint)', [String(chatA)]);
    const other = await pool.connect();
    try {
      const lock = await other.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [String(chatA)]);
      assert.equal(lock.rows[0].locked, false);
    } finally { other.release(); }
    await connection.query('SELECT pg_advisory_unlock($1::bigint)', [String(chatA)]);
    await deleteMessage(chatA, 2);
    assert.equal((await selectMessages(chatA, { kind: 'hours', hours: 24 }, 3, connection)).length, 0);
    const preceding = await selectPrecedingMessages({
      chatId: chatA,
      beforeMessageId: 15,
      beforeSentAt: new Date(),
      messageThreadId: 7,
      lookbackMinutes: 15,
      maxMessages: 12,
    });
    // Preceding context includes bot replies.
    assert.deepEqual(preceding.map((r) => r.text), ['topic-a-1', 'topic-a-2', 'bot reply in topic']);
    const afterPersist = await selectPrecedingMessages({
      chatId: chatA,
      beforeMessageId: 99,
      beforeSentAt: new Date(),
      messageThreadId: 7,
      lookbackMinutes: 15,
      maxMessages: 12,
    });
    assert.ok(afterPersist.some((r) => r.text === 'persisted bot text'));
    assert.equal(afterPersist.some((r) => r.message_id === 21), false);
    const botFlag = await pool.query<{ is_bot: boolean }>(
      'SELECT is_bot FROM messages WHERE chat_id = $1 AND message_id = 20',
      [chatA],
    );
    assert.equal(botFlag.rows[0]?.is_bot, true);
    const storedThread = await pool.query<{ message_thread_id: number | null }>(
      'SELECT message_thread_id FROM messages WHERE chat_id = $1 AND message_id = 10',
      [chatA],
    );
    assert.equal(storedThread.rows[0]?.message_thread_id, 7);
    await cleanup();
    assert.equal((await pool.query('SELECT 1 FROM messages WHERE chat_id = $1 AND message_id = 4', [chatA])).rowCount, 0);
  } finally { connection.release(); }
  console.log('Postgres integration checks passed');
} finally {
  await pool.query('DELETE FROM messages WHERE chat_id = ANY($1::bigint[])', [[chatA, chatB]]);
  await pool.query('DELETE FROM summary_requests WHERE chat_id = ANY($1::bigint[])', [[chatA, chatB]]);
  await pool.end();
}

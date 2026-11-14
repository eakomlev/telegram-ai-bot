// Run against a disposable database only: npm run test:integration
import assert from 'node:assert/strict';
import { pool, initializeDatabase, saveMessage, selectMessages, claimSummary, deleteMessage, cleanup } from '../src/db.js';

const chatA = -987654321001;
const chatB = -987654321002;
try {
  await initializeDatabase();
  await pool.query('DELETE FROM messages WHERE chat_id = ANY($1::bigint[])', [[chatA, chatB]]);
  await pool.query('DELETE FROM summary_requests WHERE chat_id = ANY($1::bigint[])', [[chatA, chatB]]);
  const row = (id: number, text: string, ageHours = 0) => ({ message_id: id, author: 'Тест', text, sent_at: new Date(Date.now() - ageHours * 3600000) });
  await saveMessage(chatA, row(1, 'old', 48));
  await saveMessage(chatA, row(2, 'original', 1));
  await saveMessage(chatA, row(2, 'edited', 1));
  await saveMessage(chatA, row(3, 'future command boundary'));
  await saveMessage(chatB, row(1, 'other chat'));
  await saveMessage(chatA, row(4, 'expired', 24 * 31));
  const connection = await pool.connect();
  try {
    const rows = await selectMessages(chatA, { kind: 'count', count: 10 }, 3, connection);
    assert.deepEqual(rows.map((r) => r.text), ['old', 'edited']);
    const recent = await selectMessages(chatA, { kind: 'hours', hours: 24 }, 3, connection);
    assert.deepEqual(recent.map((r) => r.text), ['edited']);
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
    await cleanup();
    assert.equal((await pool.query('SELECT 1 FROM messages WHERE chat_id = $1 AND message_id = 4', [chatA])).rowCount, 0);
  } finally { connection.release(); }
  console.log('Postgres integration checks passed');
} finally {
  await pool.query('DELETE FROM messages WHERE chat_id = ANY($1::bigint[])', [[chatA, chatB]]);
  await pool.query('DELETE FROM summary_requests WHERE chat_id = ANY($1::bigint[])', [[chatA, chatB]]);
  await pool.end();
}

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Api } from 'grammy';
import { pool } from '../src/core/db.js';
import { config } from '../src/config.js';
import { cancelAutoAnswerForEdit } from '../src/auto-answer/auto-answer.js';
import { runAutoAnswerSchedulerTick, stopAutoAnswerScheduler } from '../src/auto-answer/auto-answer-scheduler.js';
import { runChatGcSchedulerTick, stopChatGcScheduler } from '../src/chat/chat-gc-scheduler.js';
import { runNewsSchedulerTick, stopNewsScheduler } from '../src/news/news-scheduler.js';
import { zonedMoscowTime } from '../src/core/moscow-time.js';
import type { Message } from 'grammy/types';

test('editing cancels only the original question even after removing its caption', async () => {
  const query = pool.query;
  const calls: unknown[][] = [];
  pool.query = (async (_sql: string, values: unknown[]) => { calls.push(values); return { rowCount: 1, rows: [] }; }) as any;
  try {
    await cancelAutoAnswerForEdit({ chat: { id: -12, type: 'supergroup' }, message_id: 34, from: { id: 5, is_bot: false, first_name: 'A' } } as Message);
    assert.deepEqual(calls, [['-12', 34, 'cancelled']]);
  } finally { pool.query = query; }
});

test('schedulers coalesce overlapping ticks and stop waits for work', async () => {
  const originalQuery = pool.query;
  const oldAuto = config.AUTO_ANSWER_ENABLED;
  const oldNews = config.NEWS_ENABLED;
  const oldGc = config.CHAT_GC_ENABLED;
  const oldGcDelay = config.CHAT_GC_PROBE_DELAY_MS;
  config.AUTO_ANSWER_ENABLED = 'true';
  config.NEWS_ENABLED = 'true';
  config.CHAT_GC_ENABLED = 'true';
  config.CHAT_GC_PROBE_DELAY_MS = 0;
  const chatGcNow = zonedMoscowTime(2024, 6, 1, 4, 0);
  try {
    for (const [run, stop, now] of [
      [runAutoAnswerSchedulerTick, stopAutoAnswerScheduler, undefined],
      [runNewsSchedulerTick, stopNewsScheduler, undefined],
      [runChatGcSchedulerTick, stopChatGcScheduler, chatGcNow],
    ] as const) {
      let queries = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      pool.query = (async () => { queries++; await gate; return { rows: [] }; }) as any;
      const first = now ? run({} as Api, now) : run({} as Api);
      const second = now ? run({} as Api, now) : run({} as Api);
      assert.equal(first, second);
      assert.equal(queries, 1);
      let stopped = false;
      const stopping = stop().then(() => { stopped = true; });
      await Promise.resolve();
      assert.equal(stopped, false);
      release();
      await Promise.all([first, second, stopping]);
      assert.equal(stopped, true);
    }
  } finally {
    pool.query = originalQuery;
    config.AUTO_ANSWER_ENABLED = oldAuto;
    config.NEWS_ENABLED = oldNews;
    config.CHAT_GC_ENABLED = oldGc;
    config.CHAT_GC_PROBE_DELAY_MS = oldGcDelay;
  }
});

test('auto-answer claims use a fresh clock after earlier work exceeds the lease', async () => {
  const query = pool.query;
  const dateNow = Date.now;
  const oldEnabled = config.AUTO_ANSWER_ENABLED;
  let elapsed = 0;
  Date.now = () => elapsed;
  config.AUTO_ANSWER_ENABLED = 'true';
  const anchor = new Date('2026-01-01T12:00:00Z');
  const leases: Date[] = [];
  const row = (id: number) => ({ chat_id: '-12', message_id: id, message_thread_id: null, author: 'A', question_text: 'Question?', asker_user_id: '1', created_at: anchor, due_at: anchor, status: 'pending', claimed_until: null, answer_text: null });
  pool.query = (async (sql: string, values: any[] = []) => {
    if (sql.includes('FROM pending_auto_answers') && sql.includes('ORDER BY due_at')) return { rows: [row(1), row(2)] };
    if (sql.includes("SET status = 'claimed'")) {
      leases.push(values[2]);
      return { rows: [{ ...row(values[1]), status: 'claimed', claimed_until: values[2] }] };
    }
    if (sql.includes('FROM chat_settings')) return { rows: [] }; // default auto-answer is disabled
    if (sql.includes('UPDATE pending_auto_answers')) elapsed += 240_000;
    return { rowCount: 1, rows: [] };
  }) as any;
  try {
    await runAutoAnswerSchedulerTick({} as Api, anchor);
    assert.equal(leases.length, 2);
    assert.equal(leases[0]!.getTime(), anchor.getTime() + 180_000);
    assert.equal(leases[1]!.getTime(), anchor.getTime() + 240_000 + 180_000);
  } finally { pool.query = query; Date.now = dateNow; config.AUTO_ANSWER_ENABLED = oldEnabled; }
});

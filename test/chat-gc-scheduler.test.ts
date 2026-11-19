import assert from 'node:assert/strict';
import test from 'node:test';
import type { Api } from 'grammy';
import { GrammyError } from 'grammy';
import {
  isChatGcHourDue,
  runChatGcSchedulerTick,
  stopChatGcScheduler,
} from '../src/chat/chat-gc-scheduler.js';
import { config } from '../src/config.js';
import { pool, purgeChatData } from '../src/core/db.js';
import { zonedMoscowTime } from '../src/core/moscow-time.js';

function grammyError(errorCode: number, description: string) {
  return new GrammyError(
    'Request failed',
    { ok: false, error_code: errorCode, description },
    'getChat',
    {},
  );
}

async function withGcTestEnv(fn: () => Promise<void>) {
  const previous = {
    enabled: config.CHAT_GC_ENABLED,
    delay: config.CHAT_GC_PROBE_DELAY_MS,
  };
  config.CHAT_GC_ENABLED = 'true';
  config.CHAT_GC_PROBE_DELAY_MS = 0;
  await stopChatGcScheduler();
  try {
    await fn();
  } finally {
    await stopChatGcScheduler();
    config.CHAT_GC_ENABLED = previous.enabled;
    config.CHAT_GC_PROBE_DELAY_MS = previous.delay;
  }
}

test('isChatGcHourDue respects configured Moscow hours', () => {
  const hours = new Set([4, 16]);
  assert.equal(isChatGcHourDue(zonedMoscowTime(2024, 6, 1, 4, 0), hours), true);
  assert.equal(isChatGcHourDue(zonedMoscowTime(2024, 6, 1, 16, 30), hours), true);
  assert.equal(isChatGcHourDue(zonedMoscowTime(2024, 6, 1, 5, 0), hours), false);
  assert.equal(isChatGcHourDue(zonedMoscowTime(2024, 6, 1, 3, 59), hours), false);
});

test('chat GC skips when disabled or outside Moscow GC hours', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    let listed = 0;
    pool.query = (async () => {
      listed += 1;
      return { rows: [{ chat_id: '-99' }] };
    }) as typeof pool.query;
    try {
      config.CHAT_GC_ENABLED = 'false';
      await runChatGcSchedulerTick({} as Api, zonedMoscowTime(2024, 6, 1, 4, 0));
      assert.equal(listed, 0);

      config.CHAT_GC_ENABLED = 'true';
      await runChatGcSchedulerTick({} as Api, zonedMoscowTime(2024, 6, 1, 5, 0));
      assert.equal(listed, 0);
    } finally {
      pool.query = originalQuery;
    }
  });
});

test('chat GC purges on permanent errors, continues on transient, once per slot', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const purgedIds: string[] = [];
    const probed: number[] = [];

    pool.query = (async (sql: string) => {
      if (sql.includes('UNION') && sql.includes('chat_participants')) {
        return { rows: [{ chat_id: '-1' }, { chat_id: '-2' }, { chat_id: '-3' }] };
      }
      return { rows: [] };
    }) as typeof pool.query;

    pool.connect = (async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.startsWith('DELETE FROM') && values[0] != null) {
          purgedIds.push(String(values[0]));
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    })) as typeof pool.connect;

    const api = {
      getChat: async (chatId: number) => {
        probed.push(chatId);
        if (chatId === -1) {
          throw grammyError(403, 'Forbidden: bot was kicked from the group chat');
        }
        if (chatId === -2) {
          throw grammyError(500, 'Internal Server Error');
        }
        return { id: chatId };
      },
    } as unknown as Api;

    const now = zonedMoscowTime(2024, 6, 1, 4, 0);
    try {
      await runChatGcSchedulerTick(api, now);
      assert.deepEqual(probed, [-1, -2, -3]);
      assert.ok(purgedIds.includes('-1'));
      assert.ok(!purgedIds.includes('-2'));
      assert.ok(!purgedIds.includes('-3'));

      probed.length = 0;
      await runChatGcSchedulerTick(api, now);
      assert.deepEqual(probed, []);

      // Next configured hour is a new slot.
      await runChatGcSchedulerTick(api, zonedMoscowTime(2024, 6, 1, 16, 0));
      assert.deepEqual(probed, [-1, -2, -3]);
    } finally {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    }
  });
});

test('chat GC aborts remaining probes on 429 and does not complete the slot', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    const probed: number[] = [];
    let pass = 0;

    pool.query = (async (sql: string) => {
      if (sql.includes('UNION') && sql.includes('chat_participants')) {
        return { rows: [{ chat_id: '-10' }, { chat_id: '-11' }] };
      }
      return { rows: [] };
    }) as typeof pool.query;

    const api = {
      getChat: async (chatId: number) => {
        probed.push(chatId);
        if (pass === 0 && chatId === -10) {
          throw grammyError(429, 'Too Many Requests: retry after 3');
        }
        return { id: chatId };
      },
    } as unknown as Api;

    const now = zonedMoscowTime(2024, 6, 1, 4, 0);
    try {
      await runChatGcSchedulerTick(api, now);
      assert.deepEqual(probed, [-10]);

      pass = 1;
      probed.length = 0;
      await runChatGcSchedulerTick(api, now);
      assert.deepEqual(probed, [-10, -11]);

      probed.length = 0;
      await runChatGcSchedulerTick(api, now);
      assert.deepEqual(probed, []);
    } finally {
      pool.query = originalQuery;
    }
  });
});

test('chat GC ticks coalesce and stop waits for the running tick', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    let queries = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    pool.query = (async () => {
      queries += 1;
      await gate;
      return { rows: [] };
    }) as typeof pool.query;

    const now = zonedMoscowTime(2024, 6, 1, 4, 0);
    try {
      const first = runChatGcSchedulerTick({} as Api, now);
      const second = runChatGcSchedulerTick({} as Api, now);
      assert.equal(first, second);
      assert.equal(queries, 1);
      let stopped = false;
      const stopping = stopChatGcScheduler().then(() => { stopped = true; });
      await Promise.resolve();
      assert.equal(stopped, false);
      release();
      await Promise.all([first, second, stopping]);
      assert.equal(stopped, true);
    } finally {
      pool.query = originalQuery;
    }
  });
});

test('purgeChatData deletes chat-scoped tables in one transaction', async () => {
  const originalConnect = pool.connect;
  const statements: string[] = [];
  let released = false;
  pool.connect = (async () => ({
    query: async (sql: string) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      return { rows: [], rowCount: 0 };
    },
    release() { released = true; },
  })) as typeof pool.connect;

  try {
    await purgeChatData(-42);
    assert.deepEqual(statements, [
      'BEGIN',
      'DELETE FROM pending_auto_answers',
      'DELETE FROM messages',
      'DELETE FROM summary_requests',
      'DELETE FROM chat_participants',
      'DELETE FROM chat_member_snapshots',
      'DELETE FROM openai_usage',
      'DELETE FROM chat_settings',
      'COMMIT',
    ]);
    assert.equal(released, true);
    assert.ok(!statements.some((s) => s.includes('video_cache')));
  } finally {
    pool.connect = originalConnect;
  }
});

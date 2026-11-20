import assert from 'node:assert/strict';
import test from 'node:test';
import type { Api } from 'grammy';
import { GrammyError } from 'grammy';
import {
  isChatGcHourDue,
  runChatGcNow,
  runChatGcSchedulerTick,
  stopChatGcScheduler,
} from '../src/chat/chat-gc-scheduler.js';
import { allowedChatIds, config } from '../src/config.js';
import { pool, purgeChatData } from '../src/core/db.js';
import { zonedMoscowTime } from '../src/core/moscow-time.js';
import { isPermanentTelegramDeliveryError } from '../src/chat/telegram-errors.js';

function grammyError(
  errorCode: number,
  description: string,
  parameters: { migrate_to_chat_id?: number } = {},
) {
  return new GrammyError(
    'Request failed',
    { ok: false, error_code: errorCode, description, parameters },
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

test('owner chat check runs outside the scheduled hour and closes that hour slot', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const purgedIds: string[] = [];
    const probed: number[] = [];

    pool.query = (async (sql: string) => {
      if (sql.includes('UNION') && sql.includes('chat_member_snapshots')) {
        return { rows: [{ chat_id: '-5' }, { chat_id: '-6' }, { chat_id: '42' }] };
      }
      return { rows: [] };
    }) as typeof pool.query;

    pool.connect = (async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.startsWith('DELETE FROM') && values[0] != null) purgedIds.push(String(values[0]));
        return { rows: [], rowCount: 0 };
      },
      release() {},
    })) as typeof pool.connect;

    const api = {
      getChat: async (chatId: number) => {
        probed.push(chatId);
        if (chatId === -5) throw grammyError(403, 'Forbidden: bot was kicked from the group chat');
        return { id: chatId };
      },
      getChatMemberCount: async () => 2,
    } as unknown as Api;

    try {
      const outside = await runChatGcNow(api, zonedMoscowTime(2024, 6, 1, 5, 0));
      assert.equal(typeof outside, 'object');
      if (typeof outside !== 'object') return;
      assert.deepEqual(probed, [-5, -6]);
      assert.equal(outside.candidates, 2);
      assert.equal(outside.alive, 1);
      assert.deepEqual(outside.purged, [{ chatId: -5, kind: 'gone' }]);
      assert.ok(purgedIds.includes('-5'));

      probed.length = 0;
      const duringSlot = await runChatGcNow(api, zonedMoscowTime(2024, 6, 1, 4, 0));
      assert.equal(typeof duringSlot, 'object');
      assert.deepEqual(probed, [-5, -6]);

      probed.length = 0;
      await runChatGcSchedulerTick(api, zonedMoscowTime(2024, 6, 1, 4, 30));
      assert.deepEqual(probed, []);
    } finally {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    }
  });
});

test('owner chat check refuses when disabled and while a pass is running', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    config.CHAT_GC_ENABLED = 'false';
    pool.query = (async () => {
      throw new Error('should not list chats');
    }) as typeof pool.query;
    try {
      assert.equal(await runChatGcNow({} as Api, zonedMoscowTime(2024, 6, 1, 4, 0)), 'disabled');
    } finally {
      pool.query = originalQuery;
    }

    config.CHAT_GC_ENABLED = 'true';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    pool.query = (async () => {
      await gate;
      return { rows: [] };
    }) as typeof pool.query;
    const now = zonedMoscowTime(2024, 6, 1, 4, 0);
    try {
      const running = runChatGcSchedulerTick({} as Api, now);
      assert.equal(await runChatGcNow({} as Api, now), 'busy');
      release();
      await running;
    } finally {
      pool.query = originalQuery;
    }
  });
});

test('deleted basic group still answers getChat but fails member count and is purged', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const purgedIds: string[] = [];
    const memberCounts: number[] = [];

    pool.query = (async (sql: string) => {
      if (sql.includes('UNION') && sql.includes('chat_member_snapshots')) {
        return { rows: [{ chat_id: '-15' }, { chat_id: '-16' }] };
      }
      return { rows: [] };
    }) as typeof pool.query;

    pool.connect = (async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.startsWith('DELETE FROM') && values[0] != null) purgedIds.push(String(values[0]));
        return { rows: [], rowCount: 0 };
      },
      release() {},
    })) as typeof pool.connect;

    const api = {
      getChat: async (chatId: number) => ({ id: chatId, title: 'gone' }),
      getChatMemberCount: async (chatId: number) => {
        memberCounts.push(chatId);
        if (chatId === -15) throw grammyError(403, 'Forbidden: the group chat was deleted');
        return 3;
      },
    } as unknown as Api;

    try {
      const report = await runChatGcNow(api, zonedMoscowTime(2024, 6, 1, 5, 0));
      assert.equal(typeof report, 'object');
      if (typeof report !== 'object') return;
      assert.deepEqual(memberCounts, [-15, -16]);
      assert.equal(report.alive, 1);
      assert.deepEqual(report.purged, [{ chatId: -15, kind: 'gone' }]);
      assert.ok(purgedIds.includes('-15'));
      assert.ok(!purgedIds.includes('-16'));
    } finally {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    }
  });
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
      if (sql.includes('UNION') && sql.includes('chat_member_snapshots')) {
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
      getChatMemberCount: async () => 2,
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

test('chat GC purges old id on group→supergroup upgrade errors', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const purgedIds: string[] = [];
    const probed: number[] = [];

    pool.query = (async (sql: string) => {
      if (sql.includes('UNION') && sql.includes('chat_member_snapshots')) {
        return { rows: [{ chat_id: '-50' }, { chat_id: '-51' }] };
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
        if (chatId === -50) {
          throw grammyError(
            400,
            'Bad Request: group chat was upgraded to a supergroup chat',
            { migrate_to_chat_id: -100999 },
          );
        }
        return { id: chatId };
      },
      getChatMemberCount: async () => 2,
    } as unknown as Api;

    try {
      await runChatGcSchedulerTick(api, zonedMoscowTime(2024, 6, 1, 4, 0));
      assert.deepEqual(probed, [-50, -51]);
      assert.ok(purgedIds.includes('-50'));
      assert.ok(!purgedIds.includes('-51'));
    } finally {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    }
  });
});

test('chat GC probes and purges chats outside ALLOWED_CHAT_IDS', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const purgedIds: string[] = [];
    const probed: number[] = [];
    const previousAllowlist = [...allowedChatIds];
    allowedChatIds.clear();
    allowedChatIds.add('-100');

    pool.query = (async (sql: string) => {
      if (sql.includes('UNION') && sql.includes('chat_member_snapshots')) {
        return { rows: [{ chat_id: '-200' }, { chat_id: '-100' }] };
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
        if (chatId === -200) {
          throw grammyError(400, 'Bad Request: chat not found');
        }
        return { id: chatId };
      },
      getChatMemberCount: async () => 2,
    } as unknown as Api;

    try {
      await runChatGcSchedulerTick(api, zonedMoscowTime(2024, 6, 1, 4, 0));
      assert.deepEqual(probed, [-200, -100]);
      assert.ok(purgedIds.includes('-200'));
      assert.ok(!purgedIds.includes('-100'));
    } finally {
      pool.query = originalQuery;
      pool.connect = originalConnect;
      allowedChatIds.clear();
      for (const id of previousAllowlist) allowedChatIds.add(id);
    }
  });
});

test('chat GC skips positive private chat ids', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const purgedIds: string[] = [];
    const probed: number[] = [];

    pool.query = (async (sql: string) => {
      if (sql.includes('UNION') && sql.includes('chat_member_snapshots')) {
        return { rows: [{ chat_id: '12345' }, { chat_id: '-90' }] };
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
        if (chatId === -90) {
          throw grammyError(403, 'Forbidden: bot was kicked from the group chat');
        }
        return { id: chatId };
      },
      getChatMemberCount: async () => 2,
    } as unknown as Api;

    try {
      await runChatGcSchedulerTick(api, zonedMoscowTime(2024, 6, 1, 4, 0));
      assert.deepEqual(probed, [-90]);
      assert.ok(purgedIds.includes('-90'));
      assert.ok(!purgedIds.includes('12345'));
    } finally {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    }
  });
});

test('chat GC purges on deactivated group and PEER_ID_INVALID', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const purgedIds: string[] = [];

    pool.query = (async (sql: string) => {
      if (sql.includes('UNION') && sql.includes('chat_member_snapshots')) {
        return { rows: [{ chat_id: '-80' }, { chat_id: '-81' }] };
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
        if (chatId === -80) {
          throw grammyError(400, 'Bad Request: group is deactivated');
        }
        if (chatId === -81) {
          throw grammyError(400, 'Bad Request: PEER_ID_INVALID');
        }
        return { id: chatId };
      },
      getChatMemberCount: async () => 2,
    } as unknown as Api;

    try {
      await runChatGcSchedulerTick(api, zonedMoscowTime(2024, 6, 1, 4, 0));
      assert.ok(purgedIds.includes('-80'));
      assert.ok(purgedIds.includes('-81'));
    } finally {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    }
  });
});

test('isPermanentTelegramDeliveryError includes deactivated, deleted groups and peer_id_invalid', () => {
  assert.equal(
    isPermanentTelegramDeliveryError(grammyError(400, 'Bad Request: group is deactivated')),
    true,
  );
  assert.equal(
    isPermanentTelegramDeliveryError(grammyError(400, 'Forbidden: the group chat was deleted')),
    true,
  );
  assert.equal(
    isPermanentTelegramDeliveryError(grammyError(400, 'Bad Request: PEER_ID_INVALID')),
    true,
  );
});

test('chat GC leaves slot open when purge fails so the next tick retries', async () => {
  await withGcTestEnv(async () => {
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const probed: number[] = [];
    let purgeAttempts = 0;
    let failPurge = true;

    pool.query = (async (sql: string) => {
      if (sql.includes('UNION') && sql.includes('chat_member_snapshots')) {
        return { rows: [{ chat_id: '-70' }] };
      }
      return { rows: [] };
    }) as typeof pool.query;

    pool.connect = (async () => ({
      query: async (sql: string) => {
        if (sql === 'BEGIN') {
          purgeAttempts += 1;
          if (failPurge) throw new Error('simulated purge failure');
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    })) as typeof pool.connect;

    const api = {
      getChat: async (chatId: number) => {
        probed.push(chatId);
        throw grammyError(403, 'Forbidden: bot was kicked from the group chat');
      },
    } as unknown as Api;

    const now = zonedMoscowTime(2024, 6, 1, 4, 0);
    try {
      await runChatGcSchedulerTick(api, now);
      assert.deepEqual(probed, [-70]);
      assert.equal(purgeAttempts, 1);

      failPurge = false;
      probed.length = 0;
      await runChatGcSchedulerTick(api, now);
      assert.deepEqual(probed, [-70]);
      assert.equal(purgeAttempts, 2);

      probed.length = 0;
      await runChatGcSchedulerTick(api, now);
      assert.deepEqual(probed, []);
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
      if (sql.includes('UNION') && sql.includes('chat_member_snapshots')) {
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
      getChatMemberCount: async () => 2,
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
      'DELETE FROM chat_memory',
      'DELETE FROM summary_requests',
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

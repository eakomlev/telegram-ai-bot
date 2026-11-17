import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'grammy';
import { enqueueMedia } from '../src/media-jobs.js';

test('short cooldown in another chat cannot expire a long cooldown', async () => {
  const original = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const calls: number[] = [];
  const ctx = (id: number) => ({ chat: { id }, reply: async () => {} }) as unknown as Context;
  try {
    await enqueueMedia(ctx(1), async () => { calls.push(1); }, { cooldownSeconds: 300 });
    await Promise.resolve();
    now += 11_000;
    await enqueueMedia(ctx(2), async () => { calls.push(2); }, { cooldownSeconds: 10 });
    await Promise.resolve();
    await enqueueMedia(ctx(1), async () => { calls.push(1); }, { cooldownSeconds: 300 });
    assert.deepEqual(calls, [1, 2]);
    now += 300_000;
    await enqueueMedia(ctx(1), async () => { calls.push(1); }, { cooldownSeconds: 300 });
    assert.deepEqual(calls, [1, 2, 1]);
  } finally { Date.now = original; }
});

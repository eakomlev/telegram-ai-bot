import assert from 'node:assert/strict';
import test from 'node:test';
import { AiJobs } from '../src/core/ai-jobs.js';

test('AI work returns immediately, bounds concurrency and drains on shutdown', async () => {
  const jobs = new AiJobs(2);
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  let completed = false;
  assert.equal(jobs.start(1, async () => { await blocked; completed = true; }), true);
  assert.equal(jobs.start(1, async () => {}), false, 'same chat is busy');
  assert.equal(jobs.start(2, async () => blocked), true);
  assert.equal(jobs.start(3, async () => {}), false, 'global limit');
  await Promise.resolve();
  assert.equal(completed, false);
  const draining = jobs.stop();
  assert.equal(jobs.start(4, async () => {}), false, 'no new work during shutdown');
  finish();
  await draining;
  assert.equal(completed, true);
});

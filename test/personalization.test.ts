import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  formatInterlocutorCharacteristicBlock,
  parseCharacteristicDrafts,
  truncateCharacteristicForPrompt,
} from '../src/ai.js';
import { chronologicalFromNewestFirst } from '../src/db.js';
import { pickInjectedCharacteristic } from '../src/mention.js';
import {
  isPersonalizationDayDue,
  isPersonalizationHourDue,
  shouldRetryPersonalizationClaim,
} from '../src/personalization-scheduler.js';
import {
  batchParticipants,
  buildPersonalizationTranscript,
  chunkTranscriptByChars,
  formatTranscriptLine,
  isChatMemberCountEligible,
  personalizationChatDir,
  personalizationDraftPath,
  selectActivePersonalizationTargets,
  shouldClearPersonalizationClaim,
  wipeChatDraftDir,
  writeDraftFiles,
} from '../src/personalization.js';
import { zonedMoscowTime } from '../src/moscow-time.js';
import { config } from '../src/config.js';

test('formatTranscriptLine uses [userId|displayName]: text', () => {
  assert.equal(
    formatTranscriptLine({ authorUserId: 42, displayName: 'Аня', text: 'привет' }),
    '[42|Аня]: привет',
  );
});

test('buildPersonalizationTranscript joins chronological lines', () => {
  const text = buildPersonalizationTranscript([
    { authorUserId: 1, displayName: 'A', text: 'one', sentAt: new Date() },
    { authorUserId: 2, displayName: 'B', text: 'two', sentAt: new Date() },
  ]);
  assert.equal(text, '[1|A]: one\n[2|B]: two');
});

test('parseCharacteristicDrafts accepts object JSON and fenced blocks', () => {
  const map = parseCharacteristicDrafts('```json\n{"101":"Любит кофе","202":"Молчит"}\n```');
  assert.equal(map.get(101), 'Любит кофе');
  assert.equal(map.get(202), 'Молчит');
  assert.equal(parseCharacteristicDrafts('not json').size, 0);
  const arrayMap = parseCharacteristicDrafts(
    JSON.stringify([{ user_id: 7, draft: 'Краткий' }, { id: 'bad', text: 'x' }]),
  );
  assert.equal(arrayMap.get(7), 'Краткий');
  assert.equal(arrayMap.has(NaN as unknown as number), false);
});

test('truncateCharacteristicForPrompt respects max chars', () => {
  assert.equal(truncateCharacteristicForPrompt('коротко', 100), 'коротко');
  assert.equal(truncateCharacteristicForPrompt('abcdef', 4), 'abc…');
  assert.equal(truncateCharacteristicForPrompt('   ', 10), '');
  assert.match(formatInterlocutorCharacteristicBlock('тест'), /Характеристика собеседника/);
  assert.equal(formatInterlocutorCharacteristicBlock(''), '');
  assert.equal(config.PERSONALIZATION_PROMPT_MAX_CHARS, 3000);
});

test('member-count gate fails closed for unknown counts', () => {
  assert.equal(isChatMemberCountEligible(19, 20), true);
  assert.equal(isChatMemberCountEligible(20, 20), false);
  assert.equal(isChatMemberCountEligible(100, 20), false);
  assert.equal(isChatMemberCountEligible(undefined, 20), false);
  assert.equal(isChatMemberCountEligible(null, 20), false);
});

test('pickInjectedCharacteristic fails closed without member count', () => {
  assert.equal(
    pickInjectedCharacteristic({
      globalEnabled: true,
      chatEnabled: true,
      memberCount: undefined,
      characteristic: 'Любит краткие ответы',
    }),
    undefined,
  );
  assert.equal(
    pickInjectedCharacteristic({
      globalEnabled: true,
      chatEnabled: true,
      memberCount: 5,
      characteristic: 'Любит краткие ответы',
    }),
    'Любит краткие ответы',
  );
  assert.equal(
    pickInjectedCharacteristic({
      globalEnabled: true,
      chatEnabled: true,
      memberCount: 20,
      characteristic: 'Любит краткие ответы',
    }),
    undefined,
  );
});

test('selectActivePersonalizationTargets skips silent users (no fallback)', () => {
  const participants = [{ userId: 1 }, { userId: 2 }, { userId: 3 }];
  assert.deepEqual(selectActivePersonalizationTargets(participants, new Set([2])), [{ userId: 2 }]);
  assert.deepEqual(selectActivePersonalizationTargets(participants, []), []);
});

test('chronologicalFromNewestFirst reverses newest-first rows', () => {
  const newestFirst = [
    { id: 3, sentAt: new Date('2024-01-01T03:00:00Z') },
    { id: 2, sentAt: new Date('2024-01-01T02:00:00Z') },
    { id: 1, sentAt: new Date('2024-01-01T01:00:00Z') },
  ];
  assert.deepEqual(
    chronologicalFromNewestFirst(newestFirst).map((row) => row.id),
    [1, 2, 3],
  );
});

test('chunkTranscriptByChars and batchParticipants split work', () => {
  const lines = Array.from({ length: 5 }, (_, i) => `[${i}|U]: ${'x'.repeat(20)}`);
  const chunks = chunkTranscriptByChars(lines.join('\n'), 60);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 60));
  assert.deepEqual(batchParticipants([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('personalization hour and day idempotency helpers', () => {
  const before = zonedMoscowTime(2024, 6, 1, 2, 30);
  const after = zonedMoscowTime(2024, 6, 1, 3, 0);
  assert.equal(isPersonalizationHourDue(before, 3), false);
  assert.equal(isPersonalizationHourDue(after, 3), true);

  assert.equal(isPersonalizationDayDue(null, '2024-06-01'), true);
  assert.equal(isPersonalizationDayDue('2024-05-31', '2024-06-01'), true);
  assert.equal(isPersonalizationDayDue('2024-06-01', '2024-06-01'), false);
});

test('soft-failure claim helpers clear empty productive runs only', () => {
  assert.equal(shouldClearPersonalizationClaim({ skipped: true, updated: 0 }), false);
  assert.equal(shouldClearPersonalizationClaim({ skipped: true, reason: 'no_messages', updated: 0 }), false);
  assert.equal(shouldClearPersonalizationClaim({ skipped: true, reason: 'no_active_participants', updated: 0 }), false);
  assert.equal(shouldClearPersonalizationClaim({ skipped: false, updated: 2 }), false);
  assert.equal(shouldClearPersonalizationClaim({ skipped: false, updated: 0 }), true);

  assert.equal(shouldRetryPersonalizationClaim({ skipped: true, updated: 0 }), false);
  assert.equal(shouldRetryPersonalizationClaim({ skipped: false, updated: 0 }), true);
  assert.equal(shouldRetryPersonalizationClaim(undefined, new Error('drafts empty')), true);
});

test('wipeChatDraftDir then writeDraftFiles appends only within one run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pers-'));
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    const chatId = -42;
    await wipeChatDraftDir(chatId);
    await writeDraftFiles(chatId, new Map([[7, 'first']]));
    await writeDraftFiles(chatId, new Map([[7, 'second']]));
    const once = await readFile(personalizationDraftPath(chatId, 7), 'utf8');
    assert.equal(once, 'first\n\nsecond');

    await wipeChatDraftDir(chatId);
    await writeDraftFiles(chatId, new Map([[7, 'fresh']]));
    const afterWipe = await readFile(personalizationDraftPath(chatId, 7), 'utf8');
    assert.equal(afterWipe, 'fresh');
    assert.equal(personalizationChatDir(chatId), path.join(root, 'data', 'personalization', String(chatId)));
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

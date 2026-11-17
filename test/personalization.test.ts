import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatInterlocutorCharacteristicBlock,
  parseCharacteristicDrafts,
  truncateCharacteristicForPrompt,
} from '../src/ai.js';
import {
  isPersonalizationDayDue,
  isPersonalizationHourDue,
} from '../src/personalization-scheduler.js';
import {
  batchParticipants,
  buildPersonalizationTranscript,
  chunkTranscriptByChars,
  formatTranscriptLine,
  isChatMemberCountEligible,
} from '../src/personalization.js';
import { zonedMoscowTime } from '../src/moscow-time.js';

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
});

test('member-count gate excludes chats at or above max', () => {
  assert.equal(isChatMemberCountEligible(19, 20), true);
  assert.equal(isChatMemberCountEligible(20, 20), false);
  assert.equal(isChatMemberCountEligible(100, 20), false);
  assert.equal(isChatMemberCountEligible(undefined, 20), true);
  assert.equal(isChatMemberCountEligible(null, 20), true);
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

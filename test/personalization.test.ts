import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  formatInterlocutorCharacteristicBlock,
  parseCharacteristicDrafts,
  truncateCharacteristicForPrompt,
} from '../src/ai/ai.js';
import { chronologicalFromNewestFirst } from '../src/core/db.js';
import { pickInjectedCharacteristic } from '../src/mention/mention.js';
import {
  filterEligibleManualPersonalizationChats,
  formatManualPersonalizationSummary,
  formatPersonalizeChatIneligibleMessage,
  isPersonalizationDayDue,
  isPersonalizationHourDue,
  isPersonalizationRunInProgress,
  parsePersonalizeChatIdArg,
  PERSONALIZE_USAGE,
  PersonalizationBusyError,
  shouldRetryPersonalizationClaim,
} from '../src/personalization/personalization-scheduler.js';
import {
  buildPersonalizePickerKeyboard,
  parsePersonalizeCallbackData,
  PERSONALIZE_CALLBACK_PREFIX,
  truncatePersonalizeButtonLabel,
} from '../src/personalization/personalize-ui.js';
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
} from '../src/personalization/personalization.js';
import { zonedMoscowTime } from '../src/core/moscow-time.js';
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

test('parsePersonalizeChatIdArg: empty → picker signal, digits → chat, junk → invalid', () => {
  // undefined means show group picker (do not run for all chats)
  assert.equal(parsePersonalizeChatIdArg(''), undefined);
  assert.equal(parsePersonalizeChatIdArg('  '), undefined);
  assert.equal(parsePersonalizeChatIdArg('-100123'), -100123);
  assert.equal(parsePersonalizeChatIdArg('42'), 42);
  assert.equal(parsePersonalizeChatIdArg('abc'), null);
  assert.equal(parsePersonalizeChatIdArg('1.5'), null);
  assert.match(PERSONALIZE_USAGE, /\/personalize/);
});

test('parsePersonalizeCallbackData accepts run/cancel, rejects malformed', () => {
  assert.deepEqual(parsePersonalizeCallbackData('pers:cancel'), { type: 'cancel' });
  assert.deepEqual(parsePersonalizeCallbackData('pers:run:-100123'), {
    type: 'run',
    chatId: -100123,
  });
  assert.deepEqual(parsePersonalizeCallbackData('pers:run:42'), { type: 'run', chatId: 42 });
  assert.equal(parsePersonalizeCallbackData('pers:run:abc'), null);
  assert.equal(parsePersonalizeCallbackData('pers:other'), null);
  assert.equal(parsePersonalizeCallbackData('set:close'), null);
  assert.equal(PERSONALIZE_CALLBACK_PREFIX, 'pers:');
});

test('buildPersonalizePickerKeyboard: one row per group + Cancel', () => {
  const keyboard = buildPersonalizePickerKeyboard([
    { chatId: -1, label: 'Alpha (-1)' },
    { chatId: -2, label: 'Beta (-2)' },
  ]);
  const rows = keyboard.inline_keyboard;
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.[0]?.text, 'Alpha (-1)');
  assert.equal(rows[0]?.[0] && 'callback_data' in rows[0][0] ? rows[0][0].callback_data : null, 'pers:run:-1');
  assert.equal(rows[1]?.[0]?.text, 'Beta (-2)');
  assert.equal(rows[2]?.[0]?.text, 'Отмена');
  assert.equal(rows[2]?.[0] && 'callback_data' in rows[2][0] ? rows[2][0].callback_data : null, 'pers:cancel');
  assert.equal(truncatePersonalizeButtonLabel('x'.repeat(70)).length, 64);
});

test('filterEligibleManualPersonalizationChats applies allowlist when non-empty', () => {
  const enabled = [-100, -200, -300];
  assert.deepEqual(filterEligibleManualPersonalizationChats(enabled, new Set()), [-100, -200, -300]);
  assert.deepEqual(
    filterEligibleManualPersonalizationChats(enabled, new Set(['-100', '-300'])),
    [-100, -300],
  );
  // Manual run requires explicit chatIds: empty input → empty (no “all chats” fallback)
  assert.deepEqual(filterEligibleManualPersonalizationChats([], new Set()), []);
});

test('isPersonalizationRunInProgress is idle by default', () => {
  assert.equal(isPersonalizationRunInProgress(), false);
  assert.ok(new PersonalizationBusyError().name === 'PersonalizationBusyError');
});

test('formatManualPersonalizationSummary covers empty, skip, update, error', () => {
  assert.match(formatManualPersonalizationSummary([]), /Нет чатов/);
  const text = formatManualPersonalizationSummary([
    { chatId: -1, skipped: false, updated: 2 },
    { chatId: -2, skipped: true, reason: 'no_messages', updated: 0 },
    { chatId: -3, skipped: false, updated: 0, error: 'drafts empty' },
  ]);
  assert.match(text, /Персонализация завершена/);
  assert.match(text, /-1: обновлено 2/);
  assert.match(text, /-2: пропуск \(no_messages\)/);
  assert.match(text, /-3: ошибка — drafts empty/);
  assert.match(text, /Чатов: 3, обновлено участников: 2, пропусков: 1, ошибок: 1/);
});

test('formatPersonalizeChatIneligibleMessage is explicit per reason', () => {
  assert.match(formatPersonalizeChatIneligibleMessage(-1001, 'not_allowed'), /ALLOWED_CHAT_IDS/);
  assert.match(formatPersonalizeChatIneligibleMessage(-1001, 'unknown'), /неизвестен/);
  assert.match(formatPersonalizeChatIneligibleMessage(-1001, 'disabled'), /выключена/);
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

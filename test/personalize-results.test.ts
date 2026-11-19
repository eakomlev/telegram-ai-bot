import assert from 'node:assert/strict';
import test from 'node:test';
import { filterChatIdsByAllowlist } from '../src/core/db.js';
import { shouldPassPrivateMiddleware } from '../src/core/private-gate.js';
import {
  buildChatPickerKeyboard,
  buildMemberPickerKeyboard,
  EMPTY_CHATS_TEXT,
  EMPTY_MEMBERS_TEXT,
  formatAllowlistDenied,
  formatMoscowTimestamp,
  formatParticipantProfile,
  memberPickerText,
  PAGE_SIZE,
  paginateItems,
  parsePersonalizeResultsCallbackData,
  PERSONALIZE_RESULTS_CALLBACK_PREFIX,
  truncatePersonalizeResultsButtonLabel,
} from '../src/personalization/personalize-results-ui.js';
import { PERSONALIZE_CALLBACK_PREFIX } from '../src/personalization/personalize-ui.js';

test('PERSONALIZE_RESULTS_CALLBACK_PREFIX is pres: and disjoint from pers:', () => {
  assert.equal(PERSONALIZE_RESULTS_CALLBACK_PREFIX, 'pres:');
  assert.notEqual(PERSONALIZE_RESULTS_CALLBACK_PREFIX, PERSONALIZE_CALLBACK_PREFIX);
  assert.ok(!PERSONALIZE_CALLBACK_PREFIX.startsWith(PERSONALIZE_RESULTS_CALLBACK_PREFIX));
  assert.ok(!PERSONALIZE_RESULTS_CALLBACK_PREFIX.startsWith(PERSONALIZE_CALLBACK_PREFIX));
});

test('parsePersonalizeResultsCallbackData accepts cancel/chats/chat/user', () => {
  assert.deepEqual(parsePersonalizeResultsCallbackData('pres:cancel'), { type: 'cancel' });
  assert.deepEqual(parsePersonalizeResultsCallbackData('pres:chats'), { type: 'chats', page: 0 });
  assert.deepEqual(parsePersonalizeResultsCallbackData('pres:chats:2'), {
    type: 'chats',
    page: 2,
  });
  assert.deepEqual(parsePersonalizeResultsCallbackData('pres:chat:-100123'), {
    type: 'chat',
    chatId: -100123,
    page: 0,
  });
  assert.deepEqual(parsePersonalizeResultsCallbackData('pres:chat:-100123:3'), {
    type: 'chat',
    chatId: -100123,
    page: 3,
  });
  assert.deepEqual(parsePersonalizeResultsCallbackData('pres:user:-100:42'), {
    type: 'user',
    chatId: -100,
    userId: 42,
  });
});

test('parsePersonalizeResultsCallbackData rejects malformed and foreign prefixes', () => {
  assert.equal(parsePersonalizeResultsCallbackData('pres:run:-1'), null);
  assert.equal(parsePersonalizeResultsCallbackData('pres:chats:abc'), null);
  assert.equal(parsePersonalizeResultsCallbackData('pres:chat:abc'), null);
  assert.equal(parsePersonalizeResultsCallbackData('pres:user:-100'), null);
  assert.equal(parsePersonalizeResultsCallbackData('pres:user:-100:x'), null);
  assert.equal(parsePersonalizeResultsCallbackData('pers:cancel'), null);
  assert.equal(parsePersonalizeResultsCallbackData('pers:run:-1'), null);
  assert.equal(parsePersonalizeResultsCallbackData('set:close'), null);
  assert.equal(parsePersonalizeResultsCallbackData('pres:'), null);
});

test('paginateItems clamps page and slices by PAGE_SIZE', () => {
  assert.equal(PAGE_SIZE, 10);
  const items = Array.from({ length: 23 }, (_, i) => i);
  const p0 = paginateItems(items, 0);
  assert.equal(p0.page, 0);
  assert.equal(p0.totalPages, 3);
  assert.deepEqual(p0.slice, items.slice(0, 10));
  const p1 = paginateItems(items, 1);
  assert.deepEqual(p1.slice, items.slice(10, 20));
  const p2 = paginateItems(items, 2);
  assert.deepEqual(p2.slice, items.slice(20, 23));
  assert.equal(paginateItems(items, 99).page, 2);
  assert.equal(paginateItems(items, -1).page, 0);
  assert.deepEqual(paginateItems([], 0), { page: 0, totalPages: 1, slice: [] });
});

test('buildChatPickerKeyboard: page of groups + pagination + Cancel', () => {
  const chats = Array.from({ length: 12 }, (_, i) => ({
    chatId: -(i + 1),
    label: `Chat ${i + 1}`,
  }));
  const page0 = buildChatPickerKeyboard(chats, 0);
  const rows0 = page0.inline_keyboard;
  assert.equal(rows0.length, 12); // 10 chats + nav + cancel
  assert.equal(rows0[0]?.[0]?.text, 'Chat 1');
  assert.equal(
    rows0[0]?.[0] && 'callback_data' in rows0[0][0] ? rows0[0][0].callback_data : null,
    'pres:chat:-1',
  );
  const nav0 = rows0[10]!;
  assert.equal(nav0.length, 1);
  assert.equal(nav0[0]?.text, 'Далее ›');
  assert.equal(
    nav0[0] && 'callback_data' in nav0[0] ? nav0[0].callback_data : null,
    'pres:chats:1',
  );
  assert.equal(rows0[11]?.[0]?.text, 'Отмена');
  assert.equal(
    rows0[11]?.[0] && 'callback_data' in rows0[11][0] ? rows0[11][0].callback_data : null,
    'pres:cancel',
  );

  const page1 = buildChatPickerKeyboard(chats, 1);
  const rows1 = page1.inline_keyboard;
  assert.equal(rows1[0]?.[0]?.text, 'Chat 11');
  const nav1 = rows1[2]!;
  assert.equal(nav1[0]?.text, '‹ Назад');
  assert.equal(
    nav1[0] && 'callback_data' in nav1[0] ? nav1[0].callback_data : null,
    'pres:chats:0',
  );
  assert.equal(rows1[3]?.[0]?.text, 'Отмена');
});

test('buildMemberPickerKeyboard: members + back to chats + cancel', () => {
  const keyboard = buildMemberPickerKeyboard(
    -100,
    [
      { userId: 1, label: 'Alice' },
      { userId: 2, label: 'Bob' },
    ],
    0,
  );
  const rows = keyboard.inline_keyboard;
  assert.equal(rows.length, 3);
  assert.equal(
    rows[0]?.[0] && 'callback_data' in rows[0][0] ? rows[0][0].callback_data : null,
    'pres:user:-100:1',
  );
  assert.equal(
    rows[1]?.[0] && 'callback_data' in rows[1][0] ? rows[1][0].callback_data : null,
    'pres:user:-100:2',
  );
  assert.equal(rows[2]?.[0]?.text, '← К группам');
  assert.equal(
    rows[2]?.[0] && 'callback_data' in rows[2][0] ? rows[2][0].callback_data : null,
    'pres:chats',
  );
  assert.equal(rows[2]?.[1]?.text, 'Отмена');
  assert.equal(truncatePersonalizeResultsButtonLabel('x'.repeat(70)).length, 64);
});

test('buildMemberPickerKeyboard pagination uses chat page callbacks', () => {
  const members = Array.from({ length: 11 }, (_, i) => ({
    userId: i + 1,
    label: `U${i + 1}`,
  }));
  const page0 = buildMemberPickerKeyboard(-5, members, 0);
  const nav = page0.inline_keyboard[10]!;
  assert.equal(nav[0]?.text, 'Далее ›');
  assert.equal(
    nav[0] && 'callback_data' in nav[0] ? nav[0].callback_data : null,
    'pres:chat:-5:1',
  );
});

test('formatParticipantProfile uses full characteristic and Moscow timestamps', () => {
  const updated = new Date('2024-06-15T12:00:00.000Z');
  const sourceUntil = new Date('2024-06-14T12:00:00.000Z');
  const text = formatParticipantProfile({
    chatLabel: 'Alpha (-100)',
    participant: {
      chatId: -100,
      userId: 7,
      username: 'alice',
      displayName: 'Alice',
      characteristic: '  Любит шутки и кофе.  ',
      characteristicUpdatedAt: updated,
      characteristicSourceUntil: sourceUntil,
      firstSeenAt: updated,
      lastSeenAt: updated,
      updatedAt: updated,
    },
  });
  assert.match(text, /^Характеристика участника\n/);
  assert.match(text, /Имя: Alice/);
  assert.match(text, /Username: @alice/);
  assert.match(text, /user_id: 7/);
  assert.match(text, /Чат: Alpha \(-100\)/);
  assert.match(text, /Обновлено: 2024-06-15 15:00:00 МСК/);
  assert.match(text, /Источник до: 2024-06-14 15:00:00 МСК/);
  assert.match(text, /\n\nЛюбит шутки и кофе\.$/);

  const noUser = formatParticipantProfile({
    chatLabel: 'Beta',
    participant: {
      chatId: -1,
      userId: 9,
      username: null,
      displayName: 'Bob',
      characteristic: 'ok',
      characteristicUpdatedAt: null,
      characteristicSourceUntil: null,
      firstSeenAt: updated,
      lastSeenAt: updated,
      updatedAt: updated,
    },
  });
  assert.match(noUser, /Username: нет/);
  assert.match(noUser, /Обновлено: нет/);
  assert.match(noUser, /Источник до: нет/);
  assert.equal(formatMoscowTimestamp(null), 'нет');
});

test('member picker / empty / allowlist Russian strings', () => {
  assert.equal(memberPickerText('G (-1)'), 'Группа: G (-1)\nВыберите участника:');
  assert.match(EMPTY_CHATS_TEXT, /Нет групп с сохранёнными характеристиками/);
  assert.match(EMPTY_MEMBERS_TEXT, /нет сохранённых характеристик/);
  assert.equal(formatAllowlistDenied(-1001), 'Чат -1001 не входит в ALLOWED_CHAT_IDS.');
});

test('filterChatIdsByAllowlist applies allowlist when non-empty', () => {
  const ids = [-100, -200, -300];
  assert.deepEqual(filterChatIdsByAllowlist(ids, new Set()), [-100, -200, -300]);
  assert.deepEqual(
    filterChatIdsByAllowlist(ids, new Set(['-100', '-300'])),
    [-100, -300],
  );
  assert.deepEqual(filterChatIdsByAllowlist([], new Set(['-100'])), []);
});

test('shouldPassPrivateMiddleware allows personalize_results and hyphen alias', () => {
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/personalize_results',
      isOwner: true,
    }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/personalize_results@MyBot',
      isOwner: true,
    }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/personalize-results',
      isOwner: true,
    }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/personalize_results',
      isOwner: false,
    }),
    false,
  );
  // Existing personalize / callbacks still pass
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/personalize',
      isOwner: true,
    }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({ hasCallbackQuery: true, messageText: '', isOwner: false }),
    true,
  );
});

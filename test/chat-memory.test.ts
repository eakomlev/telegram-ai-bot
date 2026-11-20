import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeMentionContext, prepareMentionContextBlocks, walkReplyChain } from '../src/chat/chat-context.js';
import {
  appendPinnedFact,
  buildChatMemorySystemPrompt,
  computeChatMemoryClaimLeaseMs,
  fitChatMemoryInput,
  forgetPinnedFact,
  formatChatMemoryBlock,
  formatMemoryReply,
  isChatMemoryDue,
  isChatMemoryHourDue,
  normalizePinnedFact,
  shouldSoftSkipChatMemory,
  splitPinnedFacts,
} from '../src/chat/chat-memory.js';
import { zonedMoscowTime } from '../src/core/moscow-time.js';

test('formatChatMemoryBlock omits empty sections and separates the two that remain', () => {
  assert.equal(formatChatMemoryBlock({
    body: '  \n',
    pinned: ' \n\n ',
    bodyMaxChars: 2000,
    pinMaxChars: 1500,
  }), '');

  const bodyOnly = formatChatMemoryBlock({
    body: 'заметки',
    pinned: '',
    bodyMaxChars: 2000,
    pinMaxChars: 1500,
  });
  assert.equal(bodyOnly, [
    'Память чата (внутренний контекст; не цитируй дословно и не сообщай, что она у тебя есть):',
    'заметки',
  ].join('\n'));
  assert.doesNotMatch(bodyOnly, /Закреплённые факты/);

  const pinsOnly = formatChatMemoryBlock({
    body: '',
    pinned: 'факт',
    bodyMaxChars: 2000,
    pinMaxChars: 1500,
  });
  assert.equal(pinsOnly, [
    'Закреплённые факты (их задали участники чата, не противоречь им):',
    'факт',
  ].join('\n'));
  assert.doesNotMatch(pinsOnly, /Память чата/);

  assert.equal(formatChatMemoryBlock({
    body: 'заметки',
    pinned: 'факт',
    bodyMaxChars: 2000,
    pinMaxChars: 1500,
  }), [
    'Память чата (внутренний контекст; не цитируй дословно и не сообщай, что она у тебя есть):',
    'заметки',
    '',
    'Закреплённые факты (их задали участники чата, не противоречь им):',
    'факт',
  ].join('\n'));
});

test('formatChatMemoryBlock keeps the start of an oversized body and pins', () => {
  const block = formatChatMemoryBlock({
    body: 'НАЧАЛО' + 'х'.repeat(80),
    pinned: 'ПИН' + 'у'.repeat(80),
    bodyMaxChars: 12,
    pinMaxChars: 8,
  });
  assert.match(block, /Память чата \(внутренний контекст; не цитируй дословно и не сообщай, что она у тебя есть\):\nНАЧАЛО/);
  assert.match(block, /Закреплённые факты \(их задали участники чата, не противоречь им\):\nПИН/);
  const bodyLine = block.split('\n')[1] ?? '';
  const pinLine = block.split('\n').at(-1) ?? '';
  assert.equal(bodyLine.length, 12);
  assert.equal(pinLine.length, 8);
  assert.ok(bodyLine.endsWith('…'));
  assert.ok(pinLine.endsWith('…'));
});

test('formatMemoryReply covers empty, body-only and numbered pins', () => {
  assert.equal(
    formatMemoryReply('  ', '\n\n'),
    'Память чата пуста: нет ни заметок модели, ни закреплённых фактов.',
  );
  assert.equal(formatMemoryReply('мы любим кофе', ''), [
    'Память чата:',
    'мы любим кофе',
    '',
    'Закреплённые факты:',
    'Пока нет.',
  ].join('\n'));
  assert.equal(formatMemoryReply('', 'первый\n\nвторой'), [
    'Память чата:',
    'Пока пусто.',
    '',
    'Закреплённые факты:',
    '1. первый',
    '2. второй',
  ].join('\n'));
});

test('pinned facts normalize, append, split and forget', () => {
  assert.deepEqual(splitPinnedFacts('  один  \n\n\n два \n\n'), ['один', 'два']);
  assert.equal(normalizePinnedFact('  привет \n\n\n мир  '), 'привет \n мир');
  assert.equal(normalizePinnedFact('   \n  '), '');

  assert.deepEqual(appendPinnedFact('уже', '   ', 100), { ok: false, reason: 'empty' });
  assert.deepEqual(appendPinnedFact('', '  факт  ', 100), { ok: true, pinned: 'факт' });
  assert.deepEqual(appendPinnedFact('уже', 'ещё', 100), { ok: true, pinned: 'уже\n\nещё' });
  assert.deepEqual(appendPinnedFact('aaaaaaaaaa', 'bbbb', 12), { ok: false, reason: 'full' });

  assert.deepEqual(forgetPinnedFact('a\n\nb\n\nc', ''), { ok: true, pinned: '', removed: 'all' });
  assert.deepEqual(forgetPinnedFact('a\n\nb\n\nc', '2'), { ok: true, pinned: 'a\n\nc', removed: 2 });
  assert.deepEqual(forgetPinnedFact('a', '0'), { ok: false, reason: 'missing' });
  assert.deepEqual(forgetPinnedFact('a', '3'), { ok: false, reason: 'missing' });
  assert.deepEqual(forgetPinnedFact('a', 'текст'), { ok: false, reason: 'usage' });
});

test('chat memory system prompt keeps admin pins out of the model text', () => {
  const prompt = buildChatMemorySystemPrompt();
  assert.ok(prompt.includes(
    'Закреплённые факты участников в этот текст не включай и не переписывай: они хранятся отдельно.',
  ));
  assert.doesNotMatch(prompt, /[*_`#]/);
});

test('fitChatMemoryInput drops the oldest lines and drops the transcript when memory itself is huge', () => {
  const lines = ['OLD_LINE_AAAA', 'MID_LINE_BBBB', 'NEW_LINE_CCCC'];
  const memoryHeader = 'Предыдущая память чата:\n';
  const body = 'память';
  const transcriptHeader = 'Сообщения за последние 24 ч, от старых к новым:\n';
  const full = (selected: string[]) =>
    `${memoryHeader}${body}\n\n${transcriptHeader}${selected.join('\n')}`;
  const budget = full(['MID_LINE_BBBB', 'NEW_LINE_CCCC']).length;
  const fitted = fitChatMemoryInput({
    previousBody: body,
    lines,
    maxChars: budget,
    lookbackHours: 24,
  });
  assert.equal(fitted.includes('OLD_LINE_AAAA'), false);
  assert.equal(fitted.includes('MID_LINE_BBBB'), true);
  assert.equal(fitted.includes('NEW_LINE_CCCC'), true);

  const huge = fitChatMemoryInput({
    previousBody: 'Я'.repeat(500),
    lines: ['[A]: привет'],
    maxChars: 80,
    lookbackHours: 24,
  });
  assert.equal(huge.startsWith('Предыдущая память чата:\n'), true);
  assert.equal(huge.includes('Сообщения за последние'), false);
  assert.equal(huge.includes('[A]:'), false);
  assert.ok(huge.length <= 80);
  assert.ok(huge.includes('…'));
  assert.ok(huge.includes('Я'));

  const longLine = fitChatMemoryInput({
    previousBody: 'память',
    lines: ['X'.repeat(500)],
    maxChars: 120,
    lookbackHours: 24,
  });
  assert.equal(longLine.includes('Сообщения за последние'), true);
  assert.ok(longLine.includes('…'));
  assert.ok(longLine.length <= 120);
});

test('walkReplyChain returns the root first and stops on gaps, cycles and the cap', () => {
  const rows = new Map([
    [1, { message_id: 1, reply_to_message_id: null }],
    [2, { message_id: 2, reply_to_message_id: 1 }],
    [3, { message_id: 3, reply_to_message_id: 2 }],
  ]);
  assert.deepEqual(walkReplyChain(rows, 3, 8).map((row) => row.message_id), [1, 2, 3]);
  assert.deepEqual(walkReplyChain(rows, 3, 2).map((row) => row.message_id), [2, 3]);
  assert.deepEqual(walkReplyChain(rows, 3, 1).map((row) => row.message_id), [3]);
  assert.deepEqual(walkReplyChain(rows, 3, 0), []);
  assert.deepEqual(walkReplyChain(rows, 9, 5), []);

  const gap = new Map([[3, { message_id: 3, reply_to_message_id: 2 }]]);
  assert.deepEqual(walkReplyChain(gap, 3, 8).map((row) => row.message_id), [3]);

  const cycle = new Map([
    [1, { message_id: 1, reply_to_message_id: 2 }],
    [2, { message_id: 2, reply_to_message_id: 1 }],
  ]);
  const cycled = walkReplyChain(cycle, 1, 10);
  assert.deepEqual(cycled.map((row) => row.message_id), [2, 1]);
  assert.equal(cycled.some((row) => row.message_id === 1), true);
});

test('prepareMentionContextBlocks keeps ancestors when the quote itself is long', () => {
  const quote = { author: 'Q', text: 'Ц'.repeat(400), messageId: 3 };
  const ancestor = { author: 'A', text: 'корень спора', messageId: 1 };
  const recentCopy = { author: 'A', text: 'корень спора', messageId: 1 };
  const prepared = prepareMentionContextBlocks({
    recent: [recentCopy],
    aroundQuote: [],
    thread: [ancestor, quote],
    quoteMessageId: 3,
    recentMaxChars: 500,
    aroundQuoteMaxChars: 500,
    threadMaxChars: 80,
  });
  assert.deepEqual(prepared.thread.map((line) => line.messageId), [1]);
  assert.equal(prepared.recent.length, 0);
});

test('dedupeMentionContext keeps a message in the highest-priority block', () => {
  const recentOnly = { author: 'A', text: 'a', messageId: 1 };
  const sharedAround = { author: 'B', text: 'b', messageId: 2 };
  const sharedThread = { author: 'C', text: 'c', messageId: 3 };
  const threadOnly = { author: 'E', text: 'e', messageId: 4 };
  const noId = { author: 'D', text: 'd' };
  const result = dedupeMentionContext({
    recent: [recentOnly, sharedAround, noId],
    aroundQuote: [sharedAround, sharedThread, noId],
    thread: [sharedThread, threadOnly],
  });
  assert.deepEqual(result.thread, [sharedThread, threadOnly]);
  assert.deepEqual(result.aroundQuote, [sharedAround, noId]);
  assert.deepEqual(result.recent, [recentOnly, noId]);
});

test('chat memory is due only in the configured Moscow hour and when the day is still open', () => {
  assert.equal(isChatMemoryHourDue(zonedMoscowTime(2024, 6, 1, 3, 15), 3), true);
  assert.equal(isChatMemoryHourDue(zonedMoscowTime(2024, 6, 1, 4, 0), 3), false);

  const now = new Date('2024-06-01T12:00:00Z');
  assert.equal(isChatMemoryDue({
    lastRunOn: null,
    moscowDate: '2024-06-01',
    claimedUntil: null,
    now,
  }), true);
  assert.equal(isChatMemoryDue({
    lastRunOn: '2024-06-01',
    moscowDate: '2024-06-01',
    claimedUntil: null,
    now,
  }), false);
  assert.equal(isChatMemoryDue({
    lastRunOn: '2024-05-31',
    moscowDate: '2024-06-01',
    claimedUntil: null,
    now,
  }), true);
  assert.equal(isChatMemoryDue({
    lastRunOn: null,
    moscowDate: '2024-06-01',
    claimedUntil: new Date(now.getTime() + 1000),
    now,
  }), false);
  assert.equal(isChatMemoryDue({
    lastRunOn: null,
    moscowDate: '2024-06-01',
    claimedUntil: now,
    now,
  }), true);

  assert.equal(shouldSoftSkipChatMemory(0), true);
  assert.equal(shouldSoftSkipChatMemory(-1), true);
  assert.equal(shouldSoftSkipChatMemory(1), false);
});

test('chat memory claim lease matches the news formula and floors tiny timeouts', () => {
  assert.equal(computeChatMemoryClaimLeaseMs(90_000, 1), 240_000);
  assert.equal(computeChatMemoryClaimLeaseMs(1, 0), 180_000);
});

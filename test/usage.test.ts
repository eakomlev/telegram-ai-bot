import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAiUsage,
  estimateImageCostUsd,
  estimateTextCostUsd,
  formatOwnerStatsReport,
  formatUsd,
  formatUsageReport,
} from '../src/ai/usage.js';

test('estimates text cost from env prices', () => {
  // 1M in + 1M out at defaults 2 / 10 (gpt-6-sol)
  assert.equal(estimateTextCostUsd(1_000_000, 1_000_000), 12);
  assert.ok(Math.abs(estimateTextCostUsd(1000, 500) - 0.007) < 1e-9);
});

test('estimates image cost', () => {
  assert.equal(estimateImageCostUsd(2), 0.022);
  assert.equal(estimateImageCostUsd(0), 0);
});

test('buildAiUsage combines text and images', () => {
  const usage = buildAiUsage({
    model: 'gpt-6-sol',
    promptTokens: 1_000_000,
    completionTokens: 0,
    imageCount: 1,
  });
  assert.equal(usage.estimatedCostUsd, 2 + 0.011);
  assert.equal(usage.imageCount, 1);
});

test('formatUsd picks precision by magnitude', () => {
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(0.0012), '$0.0012');
  assert.equal(formatUsd(0.045), '$0.045');
  assert.equal(formatUsd(1.2), '$1.20');
});

const sampleMonth = {
  requests: 2,
  summaryRequests: 1,
  mentionRequests: 1,
  gifRequests: 0,
  newsRequests: 0,
  autoAnswerRequests: 0,
  promptTokens: 1500,
  completionTokens: 400,
  imageCount: 1,
  estimatedCostUsd: 0.012,
};

test('formatUsageReport is a short month token summary', () => {
  const text = formatUsageReport(sampleMonth);
  assert.equal(
    text,
    'Статистика по группе за текущий месяц:\nПотрачено: 1.9k токенов',
  );
  assert.doesNotMatch(text, /\$|запросов:|картинки:|За всё время/);
});

test('formatOwnerStatsReport skeleton and chat lines', () => {
  const text = formatOwnerStatsReport({
    newChatsThisMonth: 2,
    newMembersThisMonth: 15,
    chats: [
      { name: 'Семья (-1001)', members: 42, tokens: 1200 },
      { name: '-1002', tokens: 0 },
    ],
  });
  assert.equal(
    text,
    [
      '——',
      'Новых в этом месяце',
      'Чаты: 2',
      'Участники: 15',
      '——',
      'Статистика чатов:',
      'Семья (-1001) - 42 - 1200',
      '-1002 - — - 0',
      '——',
    ].join('\n'),
  );
  assert.doesNotMatch(text, /\$/);
  assert.doesNotMatch(text, /Сегодня/);
  assert.doesNotMatch(text, /характер/i);
  assert.doesNotMatch(text, /запросов/i);
  assert.doesNotMatch(text, /Цены/);
});

test('formatOwnerStatsReport empty chats still prints section', () => {
  const text = formatOwnerStatsReport({
    newChatsThisMonth: 0,
    newMembersThisMonth: 0,
    chats: [],
  });
  assert.equal(
    text,
    [
      '——',
      'Новых в этом месяце',
      'Чаты: 0',
      'Участники: 0',
      '——',
      'Статистика чатов:',
      '——',
    ].join('\n'),
  );
});

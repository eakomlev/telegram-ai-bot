import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAiUsage,
  estimateImageCostUsd,
  estimateTextCostUsd,
  formatOwnerParticipantsReport,
  formatOwnerUsageReport,
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

const sampleToday = {
  requests: 2,
  summaryRequests: 1,
  mentionRequests: 1,
  gifRequests: 0,
  newsRequests: 0,
  autoAnswerRequests: 0,
  personalizationRequests: 0,
  promptTokens: 1500,
  completionTokens: 400,
  imageCount: 1,
  estimatedCostUsd: 0.012,
};
const sampleTotal = {
  requests: 10,
  summaryRequests: 4,
  mentionRequests: 6,
  gifRequests: 0,
  newsRequests: 0,
  autoAnswerRequests: 0,
  personalizationRequests: 0,
  promptTokens: 20000,
  completionTokens: 5000,
  imageCount: 3,
  estimatedCostUsd: 0.2,
};

test('formatUsageReport includes today and totals', () => {
  const text = formatUsageReport(sampleToday, sampleTotal);
  assert.match(text, /Сегодня \(UTC\)/);
  assert.match(text, /\$0\.012/);
  assert.match(text, /саммари 1/);
  assert.match(text, /не счёт/i);
});

test('formatOwnerUsageReport lists chats across groups', () => {
  const text = formatOwnerUsageReport(sampleToday, sampleTotal, [{
    chatId: -1001,
    label: 'Семья (-1001)',
    today: sampleToday,
    total: sampleTotal,
    members: 42,
  }], { newToday: 1, total: 4, members: 120 });
  assert.match(text, /по всем группам/i);
  assert.match(text, /новых групп: 1/);
  assert.match(text, /всего групп: 4/);
  assert.match(text, /участников: 120/);
  assert.match(text, /Семья \(-1001\)/);
  assert.match(text, /42 уч\./);
  assert.match(text, /\$0\.20/);
  assert.match(text, /сегодня \$0\.012/);
  assert.doesNotMatch(text, /Цены:/);
});

test('formatOwnerParticipantsReport empty state', () => {
  assert.equal(
    formatOwnerParticipantsReport([]),
    'Пока нет сохранённых характеристик участников.',
  );
});

test('formatOwnerParticipantsReport lists people and truncates characteristic', () => {
  const long = 'я'.repeat(250);
  const text = formatOwnerParticipantsReport([
    {
      label: 'Семья (-1001)',
      participants: [
        { displayName: 'Аня', username: 'anya', characteristic: 'любит краткие ответы' },
        { displayName: 'Иван', username: null, characteristic: long },
      ],
    },
  ]);
  assert.match(text, /^Участники и характеристики:/);
  assert.match(text, /• Семья \(-1001\):/);
  assert.match(text, /— Аня \(@anya\): любит краткие ответы/);
  assert.match(text, /— Иван: /);
  assert.ok(!text.includes(long));
  const ivanLine = text.split('\n').find((line) => line.includes('— Иван:'));
  assert.ok(ivanLine);
  assert.ok(ivanLine!.endsWith('…'));
  assert.ok(ivanLine!.length <= '  — Иван: '.length + 200);
});

test('formatOwnerParticipantsReport collapses whitespace before truncate', () => {
  const text = formatOwnerParticipantsReport([
    {
      label: 'Чат (-1)',
      participants: [
        {
          displayName: 'Аня',
          username: null,
          characteristic: 'любит\nкраткие   ответы\r\nи мемы',
        },
      ],
    },
  ]);
  assert.match(text, /— Аня: любит краткие ответы и мемы/);
  assert.doesNotMatch(text, /\n  — Аня: любит\n/);
});

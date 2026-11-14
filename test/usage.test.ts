import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAiUsage, estimateImageCostUsd, estimateTextCostUsd, formatUsd, formatUsageReport } from '../src/usage.js';

test('estimates text cost from env prices', () => {
  // 1M in + 1M out at defaults 0.4 / 1.6
  assert.equal(estimateTextCostUsd(1_000_000, 1_000_000), 2);
  assert.ok(Math.abs(estimateTextCostUsd(1000, 500) - 0.0012) < 1e-9);
});

test('estimates image cost', () => {
  assert.equal(estimateImageCostUsd(2), 0.022);
  assert.equal(estimateImageCostUsd(0), 0);
});

test('buildAiUsage combines text and images', () => {
  const usage = buildAiUsage({
    model: 'gpt-4.1-mini',
    promptTokens: 1_000_000,
    completionTokens: 0,
    imageCount: 1,
  });
  assert.equal(usage.estimatedCostUsd, 0.4 + 0.011);
  assert.equal(usage.imageCount, 1);
});

test('formatUsd picks precision by magnitude', () => {
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(0.0012), '$0.0012');
  assert.equal(formatUsd(0.045), '$0.045');
  assert.equal(formatUsd(1.2), '$1.20');
});

test('formatUsageReport includes today and totals', () => {
  const text = formatUsageReport(
    {
      requests: 2,
      summaryRequests: 1,
      mentionRequests: 1,
      promptTokens: 1500,
      completionTokens: 400,
      imageCount: 1,
      estimatedCostUsd: 0.012,
    },
    {
      requests: 10,
      summaryRequests: 4,
      mentionRequests: 6,
      promptTokens: 20000,
      completionTokens: 5000,
      imageCount: 3,
      estimatedCostUsd: 0.2,
    },
  );
  assert.match(text, /Сегодня \(UTC\)/);
  assert.match(text, /\$0\.012/);
  assert.match(text, /саммари 1/);
  assert.match(text, /не счёт/i);
});

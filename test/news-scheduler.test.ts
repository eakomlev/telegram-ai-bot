import assert from 'node:assert/strict';
import test from 'node:test';
import { GrammyError } from 'grammy';
import {
  computeNewsClaimLeaseMs,
  isPermanentTelegramDeliveryError,
  newsClaimLeaseUntil,
  nextDayNewsRunAt,
  softRetryAt,
} from '../src/news/news-scheduler.js';
import { config } from '../src/config.js';
import { moscowParts, zonedMoscowTime } from '../src/core/moscow-time.js';

function grammyError(errorCode: number, description: string) {
  return new GrammyError(
    'Bad Request',
    { ok: false, error_code: errorCode, description },
    'sendMessage',
    {},
  );
}

test('computeNewsClaimLeaseMs covers OpenAI timeout retries with a floor', () => {
  assert.equal(computeNewsClaimLeaseMs(90_000, 1, 60_000, 180_000), 240_000);
  assert.equal(computeNewsClaimLeaseMs(120_000, 1, 60_000, 180_000), 300_000);
  assert.equal(computeNewsClaimLeaseMs(30_000, 0, 60_000, 180_000), 180_000);
});

test('newsClaimLeaseUntil uses timeout-scaled lease from config', () => {
  const now = new Date('2024-03-10T12:00:00.000Z');
  const lease = newsClaimLeaseUntil(now);
  assert.equal(
    lease.getTime() - now.getTime(),
    computeNewsClaimLeaseMs(config.OPENAI_TIMEOUT_MS, config.OPENAI_MAX_RETRIES),
  );
});

test('softRetryAt stays inside today when retry is before Moscow 21:00', () => {
  const now = zonedMoscowTime(2024, 3, 10, 14, 0);
  const retry = softRetryAt(now, 20);
  assert.equal(retry.getTime(), now.getTime() + 20 * 60_000);
  assert.ok(retry.getTime() < zonedMoscowTime(2024, 3, 10, 21, 0).getTime());
});

test('softRetryAt moves to next-day window when retry would pass Moscow 21:00', () => {
  const now = zonedMoscowTime(2024, 3, 10, 20, 50);
  const retry = softRetryAt(now, 20);
  const parts = moscowParts(retry);
  assert.equal(parts.day, 11);
  assert.ok(parts.hour >= 10 && parts.hour < 21);
});

test('nextDayNewsRunAt samples the following Moscow news window', () => {
  const now = zonedMoscowTime(2024, 3, 10, 12, 0);
  const next = nextDayNewsRunAt(now);
  const parts = moscowParts(next);
  assert.equal(parts.day, 11);
  assert.ok(parts.hour >= 10 && parts.hour < 21);
});

test('isPermanentTelegramDeliveryError detects 403 and gone chats', () => {
  assert.equal(isPermanentTelegramDeliveryError(grammyError(403, 'Forbidden: bot was kicked from the group chat')), true);
  assert.equal(isPermanentTelegramDeliveryError(grammyError(400, 'Bad Request: chat not found')), true);
  assert.equal(isPermanentTelegramDeliveryError(grammyError(400, 'Bad Request: bot is not a member of the group chat')), true);
  assert.equal(isPermanentTelegramDeliveryError(grammyError(400, 'Bad Request: group is deactivated')), true);
  assert.equal(isPermanentTelegramDeliveryError(grammyError(400, 'Bad Request: PEER_ID_INVALID')), true);
  assert.equal(isPermanentTelegramDeliveryError(grammyError(429, 'Too Many Requests: retry after 3')), false);
  assert.equal(isPermanentTelegramDeliveryError(new Error('network down')), false);
});

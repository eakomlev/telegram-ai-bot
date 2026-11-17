import assert from 'node:assert/strict';
import test from 'node:test';
import {
  moscowDateString,
  moscowParts,
  pickRandomNewsRunAt,
  zonedMoscowTime,
} from '../src/core/moscow-time.js';

test('moscowParts and moscowDateString use Europe/Moscow', () => {
  // 2024-01-15 12:00 UTC = 15:00 Moscow (UTC+3)
  const date = new Date('2024-01-15T12:00:00.000Z');
  const parts = moscowParts(date);
  assert.equal(parts.year, 2024);
  assert.equal(parts.month, 1);
  assert.equal(parts.day, 15);
  assert.equal(parts.hour, 15);
  assert.equal(moscowDateString(date), '2024-01-15');
});

test('zonedMoscowTime round-trips civil Moscow time', () => {
  const instant = zonedMoscowTime(2024, 6, 1, 10, 30);
  const parts = moscowParts(instant);
  assert.equal(parts.year, 2024);
  assert.equal(parts.month, 6);
  assert.equal(parts.day, 1);
  assert.equal(parts.hour, 10);
  assert.equal(parts.minute, 30);
});

test('pickRandomNewsRunAt stays in [10:00, 21:00) Moscow', () => {
  const notBefore = zonedMoscowTime(2024, 3, 10, 9, 0);
  const runAt = pickRandomNewsRunAt(notBefore, () => 0);
  const parts = moscowParts(runAt);
  assert.equal(parts.day, 10);
  assert.equal(parts.hour, 10);
  assert.equal(parts.minute, 0);

  const late = pickRandomNewsRunAt(notBefore, () => 0.999999);
  const lateParts = moscowParts(late);
  assert.equal(lateParts.hour, 20);
  assert.ok(lateParts.minute >= 59);
});

test('pickRandomNewsRunAt samples remaining window when enabling during the day', () => {
  const notBefore = zonedMoscowTime(2024, 3, 10, 15, 0);
  const earliest = pickRandomNewsRunAt(notBefore, () => 0);
  assert.ok(earliest.getTime() > notBefore.getTime());
  assert.ok(earliest.getTime() < zonedMoscowTime(2024, 3, 10, 21, 0).getTime());
  const earlyParts = moscowParts(earliest);
  assert.equal(earlyParts.day, 10);
  assert.equal(earlyParts.hour, 15);
  assert.equal(earlyParts.minute, 0);

  const latest = pickRandomNewsRunAt(notBefore, () => 0.999999);
  const lateParts = moscowParts(latest);
  assert.equal(lateParts.day, 10);
  assert.equal(lateParts.hour, 20);
  assert.ok(lateParts.minute >= 59);
});

test('pickRandomNewsRunAt rolls to next Moscow day after the 21:00 window', () => {
  const notBefore = zonedMoscowTime(2024, 3, 10, 21, 0);
  const runAt = pickRandomNewsRunAt(notBefore, () => 0);
  const parts = moscowParts(runAt);
  assert.equal(parts.day, 11);
  assert.equal(parts.hour, 10);
  assert.equal(parts.minute, 0);
});

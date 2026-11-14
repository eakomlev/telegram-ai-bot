import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSelection, prepareMessages, splitReply } from '../src/summary.js';

test('accepts defaults, message counts and bounded periods', () => {
  assert.deepEqual(parseSelection('', 100, 1000, 30), { kind: 'count', count: 100 });
  assert.deepEqual(parseSelection('500', 100, 1000, 30), { kind: 'count', count: 500 });
  assert.deepEqual(parseSelection(' 24H ', 100, 1000, 30), { kind: 'hours', hours: 24 });
  assert.deepEqual(parseSelection('7d', 100, 1000, 30), { kind: 'hours', hours: 168 });
  for (const input of ['0', '-1', '1001', '31d', '0h', '1.5', '100 text', '9999999999999999999999']) {
    assert.throws(() => parseSelection(input, 100, 1000, 30));
  }
});

const row = (id: number, text: string) => ({ message_id: id, author: 'Аня', text, sent_at: new Date('2026-01-01T00:00:00Z') });
test('keeps latest messages in chronological order within JSON budget', () => {
  const result = prepareMessages([row(1, 'a'.repeat(600)), row(2, 'b'.repeat(600)), row(3, 'latest')], 1000);
  assert.equal(result.limited, true);
  assert.ok(result.json.length <= 1000);
  assert.deepEqual(JSON.parse(result.json).map((entry: { id: number }) => entry.id), [2, 3]);
});
test('bounds oversized and heavily escaped messages', () => {
  const result = prepareMessages([row(1, '\n"\\'.repeat(10000))], 1000);
  assert.equal(result.count, 1);
  assert.equal(result.limited, true);
  assert.ok(result.json.length <= 1000);
  assert.match(JSON.parse(result.json)[0].text, /обрезано/);
});
test('splits Telegram responses without losing text or breaking emoji', () => {
  const text = 'a'.repeat(3999) + '😀' + '\n' + 'б'.repeat(8000);
  const parts = splitReply(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => part.length <= 4000 && !/[\uD800-\uDBFF]$/.test(part)));
});

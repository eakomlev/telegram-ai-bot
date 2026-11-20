import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_MEMORY_MANUAL_LOOKBACK_HOURS } from '../src/chat/chat-memory.js';
import {
  buildMemoryRefreshPickerKeyboard,
  filterMemoryRefreshChatIds,
  parseMemoryRefreshCallbackData,
  truncateMemoryRefreshButtonLabel,
} from '../src/chat/chat-memory-refresh-ui.js';

test('owner memory refresh looks back three days', () => {
  assert.equal(CHAT_MEMORY_MANUAL_LOOKBACK_HOURS, 72);
});

test('parseMemoryRefreshCallbackData accepts run and cancel only', () => {
  assert.deepEqual(parseMemoryRefreshCallbackData('memr:cancel'), { type: 'cancel' });
  assert.deepEqual(parseMemoryRefreshCallbackData('memr:run:-100123'), { type: 'run', chatId: -100123 });
  assert.equal(parseMemoryRefreshCallbackData('set:close'), null);
  assert.equal(parseMemoryRefreshCallbackData('memr:run:nope'), null);
  assert.equal(parseMemoryRefreshCallbackData('memr:run:'), null);
});

test('filterMemoryRefreshChatIds keeps groups and honors the allowlist', () => {
  assert.deepEqual(filterMemoryRefreshChatIds([-10, 5, -20], new Set()), [-10, -20]);
  assert.deepEqual(filterMemoryRefreshChatIds([-10, -20, -30], new Set(['-20'])), [-20]);
});

test('memory refresh picker keyboard uses memr callbacks and truncates labels', () => {
  const keyboard = buildMemoryRefreshPickerKeyboard([
    { chatId: -7, label: 'Кухня' },
  ]);
  const rows = keyboard.inline_keyboard;
  assert.equal(rows[0]?.[0]?.text, 'Кухня');
  assert.equal(rows[0]?.[0]?.callback_data, 'memr:run:-7');
  assert.equal(rows[1]?.[0]?.callback_data, 'memr:cancel');
  assert.equal(truncateMemoryRefreshButtonLabel('я'.repeat(80)).length, 64);
  assert.ok(truncateMemoryRefreshButtonLabel('я'.repeat(80)).endsWith('…'));
});

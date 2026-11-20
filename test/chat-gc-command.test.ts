import assert from 'node:assert/strict';
import test from 'node:test';
import { formatChatGcReport } from '../src/chat/chat-gc-report.js';
import {
  buildChatCheckKeyboard,
  parseChatCheckCallbackData,
} from '../src/chat/chat-gc-ui.js';

test('formatChatGcReport summarizes a pass in Russian', () => {
  assert.equal(formatChatGcReport({
    candidates: 0,
    checked: 0,
    alive: 0,
    purged: [],
    probeErrors: [],
    purgeErrors: [],
    rateLimited: false,
  }), 'Нет известных групп для проверки.');

  const text = formatChatGcReport({
    candidates: 4,
    checked: 3,
    alive: 1,
    purged: [{ chatId: -5, kind: 'gone' }, { chatId: -50, kind: 'upgrade' }],
    probeErrors: [-2],
    purgeErrors: [-7],
    rateLimited: true,
  });
  assert.match(text, /Проверено: 3 из 4/);
  assert.match(text, /На месте: 1/);
  assert.match(text, /-5\n-50 — группа стала супергруппой/);
  assert.match(text, /Временные ошибки, данные сохранены: -2/);
  assert.match(text, /Не удалось удалить: -7/);
  assert.match(text, /ограничил частоту запросов/);
});

test('chat check callback is confirm or cancel', () => {
  assert.equal(parseChatCheckCallbackData('gc:run'), 'run');
  assert.equal(parseChatCheckCallbackData('gc:cancel'), 'cancel');
  assert.equal(parseChatCheckCallbackData('memr:run:-1'), null);
  assert.equal(parseChatCheckCallbackData('gc:nope'), null);
  const row = buildChatCheckKeyboard().inline_keyboard[0] ?? [];
  assert.deepEqual(row.map((button) => button.callback_data), ['gc:run', 'gc:cancel']);
});

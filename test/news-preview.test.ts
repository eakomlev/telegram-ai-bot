import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNewsPreviewPickerKeyboard,
  parseNewsPreviewCallbackData,
} from '../src/news/news-preview-ui.js';

test('news preview callback accepts one group or cancel', () => {
  assert.deepEqual(parseNewsPreviewCallbackData('nws:cancel'), { type: 'cancel' });
  assert.deepEqual(parseNewsPreviewCallbackData('nws:run:-1005'), { type: 'run', chatId: -1005 });
  assert.equal(parseNewsPreviewCallbackData('memr:run:-1'), null);
  assert.equal(parseNewsPreviewCallbackData('nws:run:nope'), null);
  const keyboard = buildNewsPreviewPickerKeyboard([{ chatId: -9, label: 'Кухня' }]);
  assert.equal(keyboard.inline_keyboard[0]?.[0]?.callback_data, 'nws:run:-9');
  assert.equal(keyboard.inline_keyboard[1]?.[0]?.callback_data, 'nws:cancel');
});

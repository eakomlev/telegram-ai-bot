import assert from 'node:assert/strict';
import test from 'node:test';
import {
  privateBlockedReplyText,
  shouldPassPrivateMiddleware,
  shouldReplyToBlockedPrivate,
} from '../src/core/private-gate.js';

test('shouldPassPrivateMiddleware allows callbacks and owner stats/costs', () => {
  // Regression: private middleware used to require message text, blocking set: callbacks
  assert.equal(
    shouldPassPrivateMiddleware({ hasCallbackQuery: true, messageText: '', isOwner: false }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({ hasCallbackQuery: false, messageText: '/stats', isOwner: true }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/costs@MyBot',
      isOwner: true,
    }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/stats',
      isOwner: false,
    }),
    false,
  );
  assert.equal(
    shouldPassPrivateMiddleware({ hasCallbackQuery: false, messageText: '/help', isOwner: true }),
    false,
  );
  assert.equal(
    shouldPassPrivateMiddleware({ hasCallbackQuery: false, messageText: 'hello', isOwner: true }),
    false,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/personalize',
      isOwner: true,
    }),
    false,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/memory_refresh',
      isOwner: true,
    }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/memory_refresh@MyBot',
      isOwner: true,
    }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/memory_refresh',
      isOwner: false,
    }),
    false,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/check_chats',
      isOwner: true,
    }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/check_chats@MyBot',
      isOwner: true,
    }),
    true,
  );
  assert.equal(
    shouldPassPrivateMiddleware({
      hasCallbackQuery: false,
      messageText: '/check_chats',
      isOwner: false,
    }),
    false,
  );
});

test('shouldReplyToBlockedPrivate only when message is present', () => {
  assert.equal(shouldReplyToBlockedPrivate({ hasMessage: true }), true);
  assert.equal(shouldReplyToBlockedPrivate({ hasMessage: false }), false);
});

test('privateBlockedReplyText: default redirect vs owner blocked slash command', () => {
  const defaultReply =
    'Добавьте меня в чат или группу, чтобы начать работу.\nВ @BotFather: /setprivacy → Disable.';
  const ownerCmdReply = 'В личке доступны только /stats, /costs, /memory_refresh и /check_chats.';

  assert.equal(privateBlockedReplyText({ isOwner: false, messageText: 'hi' }), defaultReply);
  assert.equal(privateBlockedReplyText({ isOwner: false, messageText: '/help' }), defaultReply);
  assert.equal(privateBlockedReplyText({ isOwner: false, messageText: '' }), defaultReply);
  assert.equal(privateBlockedReplyText({ isOwner: true, messageText: 'hello' }), defaultReply);
  assert.equal(privateBlockedReplyText({ isOwner: true, messageText: '' }), defaultReply);
  assert.equal(privateBlockedReplyText({ isOwner: true, messageText: '/help' }), ownerCmdReply);
  assert.equal(privateBlockedReplyText({ isOwner: true, messageText: '/unknown' }), ownerCmdReply);
});

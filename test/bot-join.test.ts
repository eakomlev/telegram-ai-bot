import assert from 'node:assert/strict';
import test from 'node:test';
import { isBotJoinTransition, shouldSendBotJoinWelcome } from '../src/chat/bot-join.js';

test('left→member is a join transition', () => {
  assert.equal(isBotJoinTransition('left', 'member'), true);
});

test('kicked→administrator is a join transition', () => {
  assert.equal(isBotJoinTransition('kicked', 'administrator'), true);
});

test('left→administrator is a join transition', () => {
  assert.equal(isBotJoinTransition('left', 'administrator'), true);
});

test('kicked→member is a join transition', () => {
  assert.equal(isBotJoinTransition('kicked', 'member'), true);
});

test('left→restricted is not a join transition', () => {
  assert.equal(isBotJoinTransition('left', 'restricted'), false);
});

test('restricted→member is not a join transition', () => {
  assert.equal(isBotJoinTransition('restricted', 'member'), false);
});

test('member→administrator is not a join transition', () => {
  assert.equal(isBotJoinTransition('member', 'administrator'), false);
});

test('administrator→member is not a join transition', () => {
  assert.equal(isBotJoinTransition('administrator', 'member'), false);
});

test('member→left is not a join transition', () => {
  assert.equal(isBotJoinTransition('member', 'left'), false);
});

test('group + join + empty allowlist: send welcome', () => {
  assert.equal(
    shouldSendBotJoinWelcome({
      chatType: 'group',
      chatId: -1001,
      oldStatus: 'left',
      newStatus: 'member',
      allowedChatIds: new Set(),
    }),
    true,
  );
});

test('supergroup + join + empty allowlist: send welcome', () => {
  assert.equal(
    shouldSendBotJoinWelcome({
      chatType: 'supergroup',
      chatId: -1002,
      oldStatus: 'kicked',
      newStatus: 'administrator',
      allowedChatIds: new Set(),
    }),
    true,
  );
});

test('allowlist set, chat not in set: no send', () => {
  assert.equal(
    shouldSendBotJoinWelcome({
      chatType: 'group',
      chatId: -1001,
      oldStatus: 'left',
      newStatus: 'member',
      allowedChatIds: new Set(['-9999']),
    }),
    false,
  );
});

test('allowlist set, chat in set: send', () => {
  assert.equal(
    shouldSendBotJoinWelcome({
      chatType: 'supergroup',
      chatId: -1001,
      oldStatus: 'left',
      newStatus: 'member',
      allowedChatIds: new Set(['-1001']),
    }),
    true,
  );
});

test('channel: no send', () => {
  assert.equal(
    shouldSendBotJoinWelcome({
      chatType: 'channel',
      chatId: -1001,
      oldStatus: 'left',
      newStatus: 'administrator',
      allowedChatIds: new Set(),
    }),
    false,
  );
});

test('private: no send', () => {
  assert.equal(
    shouldSendBotJoinWelcome({
      chatType: 'private',
      chatId: 12345,
      oldStatus: 'left',
      newStatus: 'member',
      allowedChatIds: new Set(),
    }),
    false,
  );
});

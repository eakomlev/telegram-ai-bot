import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GROUP_COMMANDS,
  OWNER_PRIVATE_COMMANDS,
  buildCommandRegistrationPlan,
} from '../src/core/bot-commands.js';

test('buildCommandRegistrationPlan without owner: groups + empty private', () => {
  const steps = buildCommandRegistrationPlan(undefined);
  assert.equal(steps.length, 4);
  assert.deepEqual(steps[0], {
    action: 'set',
    commands: GROUP_COMMANDS,
    scope: { type: 'default' },
  });
  assert.deepEqual(steps[1], {
    action: 'set',
    commands: GROUP_COMMANDS,
    scope: { type: 'all_group_chats' },
  });
  assert.deepEqual(steps[2], {
    action: 'delete',
    scope: { type: 'all_private_chats' },
  });
  assert.deepEqual(steps[3], {
    action: 'set',
    commands: [],
    scope: { type: 'all_private_chats' },
  });
});

test('buildCommandRegistrationPlan with owner adds chat_member scope', () => {
  const ownerId = 42_001;
  const steps = buildCommandRegistrationPlan(ownerId);
  assert.equal(steps.length, 5);
  assert.deepEqual(steps[4], {
    action: 'set',
    commands: OWNER_PRIVATE_COMMANDS,
    scope: {
      type: 'chat_member',
      chat_id: ownerId,
      user_id: ownerId,
    },
  });
  assert.equal(
    OWNER_PRIVATE_COMMANDS.map((c) => c.command).join(','),
    'stats,costs,personalize,personalize_results',
  );
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Context } from 'grammy';
import type { ChatParticipantRow } from '../src/core/db.js';
import {
  formatMeProfile,
  isEmptyCharacteristic,
  meCommandDeniedReason,
} from '../src/personalization/me.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function sampleParticipant(
  overrides: Partial<ChatParticipantRow> = {},
): ChatParticipantRow {
  const now = new Date('2024-06-15T12:00:00.000Z');
  return {
    chatId: -100,
    userId: 7,
    username: 'alice',
    displayName: 'Alice',
    characteristic: 'Любит шутки и кофе.',
    characteristicUpdatedAt: now,
    characteristicSourceUntil: now,
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeCtx(partial: {
  chatType?: Context['chat'] extends infer C | undefined
    ? C extends { type: infer T }
      ? T
      : never
    : never;
  from?: Context['from'];
  senderChat?: unknown;
}): Context {
  return {
    chat: partial.chatType ? { type: partial.chatType, id: -100 } : undefined,
    from: partial.from,
    msg: partial.senderChat !== undefined ? { sender_chat: partial.senderChat } : {},
  } as Context;
}

test('formatMeProfile trims characteristic and uses Moscow timestamp', () => {
  const updated = new Date('2024-06-15T12:00:00.000Z');
  const text = formatMeProfile(
    sampleParticipant({
      characteristic: '  Любит шутки и кофе.  ',
      characteristicUpdatedAt: updated,
    }),
  );
  assert.match(text, /^Твоя характеристика в этом чате\n/);
  assert.match(text, /Обновлено: 2024-06-15 15:00:00 МСК/);
  assert.match(text, /\n\nЛюбит шутки и кофе\.$/);
  assert.doesNotMatch(text, /user_id/);
  assert.doesNotMatch(text, /Username/);
  assert.doesNotMatch(text, /Источник до/);
  assert.doesNotMatch(text, /Чат:/);
  assert.doesNotMatch(text, /@alice/);
});

test('formatMeProfile shows «нет» when updatedAt is null', () => {
  const text = formatMeProfile(
    sampleParticipant({
      characteristic: 'ok',
      characteristicUpdatedAt: null,
    }),
  );
  assert.match(text, /Обновлено: нет/);
});

test('isEmptyCharacteristic treats null/whitespace as empty', () => {
  assert.equal(isEmptyCharacteristic(null), true);
  assert.equal(isEmptyCharacteristic(undefined), true);
  assert.equal(isEmptyCharacteristic(''), true);
  assert.equal(isEmptyCharacteristic('   '), true);
  assert.equal(isEmptyCharacteristic('есть текст'), false);
});

test('meCommandDeniedReason: private / missing from / anonymous admin', () => {
  assert.equal(
    meCommandDeniedReason(fakeCtx({ chatType: 'private', from: { id: 1 } as Context['from'] })),
    'Команда /me работает только в группе. Отправьте её в чате.',
  );
  assert.match(
    meCommandDeniedReason(fakeCtx({ chatType: 'group' })) ?? '',
    /со своего аккаунта/,
  );
  assert.match(
    meCommandDeniedReason(
      fakeCtx({
        chatType: 'supergroup',
        from: { id: 1 } as Context['from'],
        senderChat: { id: -1 },
      }),
    ) ?? '',
    /со своего аккаунта/,
  );
  assert.equal(
    meCommandDeniedReason(
      fakeCtx({ chatType: 'group', from: { id: 42 } as Context['from'] }),
    ),
    null,
  );
  assert.equal(
    meCommandDeniedReason(
      fakeCtx({ chatType: 'supergroup', from: { id: 42 } as Context['from'] }),
    ),
    null,
  );
});

test('me.ts does not read config.PERSONALIZATION_ENABLED', () => {
  const src = readFileSync(join(repoRoot, 'src/personalization/me.ts'), 'utf8');
  assert.equal(
    src.includes('config.PERSONALIZATION_ENABLED'),
    false,
    'me.ts must not gate on config.PERSONALIZATION_ENABLED',
  );
});

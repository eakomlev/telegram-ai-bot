import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from 'grammy/types';
import {
  activityCancelsPending,
  isGeneralQuestion,
  isUrlOnlyMediaCandidate,
  messageHasAnyMention,
  shouldEnqueueAutoAnswer,
} from '../src/auto-answer.js';
import {
  autoAnswerClaimLeaseUntil,
  needsOpenAiGeneration,
  ownsAutoAnswerClaim,
} from '../src/auto-answer-scheduler.js';
import { setBotIdentity } from '../src/mention.js';

setBotIdentity(42, 'summary_bot');

function textMessage(text: string, overrides: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: -1001, type: 'supergroup', title: 'Test' },
    from: { id: 7, is_bot: false, first_name: 'Ann' },
    text,
    ...overrides,
  } as Message;
}

test('isGeneralQuestion: question mark is a strong yes', () => {
  assert.equal(isGeneralQuestion('Кто-нибудь знает ресторан рядом?'), true);
  assert.equal(isGeneralQuestion('Есть идеи？'), true);
  assert.equal(isGeneralQuestion('Кто?'), true);
});

test('isGeneralQuestion: rejects short ? chatter', () => {
  assert.equal(isGeneralQuestion('ок?'), false);
  assert.equal(isGeneralQuestion('да?'), false);
  assert.equal(isGeneralQuestion('серьёзно?'), false);
  assert.equal(isGeneralQuestion('нет?'), false);
  assert.equal(isGeneralQuestion('?'), false);
});

test('isGeneralQuestion: Russian interrogatives and ли particle', () => {
  assert.equal(isGeneralQuestion('Подскажите хороший ноутбук для работы'), true);
  assert.equal(isGeneralQuestion('Где обычно паркуетесь'), true);
  assert.equal(isGeneralQuestion('Можно ли принести своего ноутбука'), true);
  assert.equal(isGeneralQuestion('Есть ли у кого HDMI кабель'), true);
  assert.equal(isGeneralQuestion('Does anyone know a good cafe nearby'), true);
});

test('isGeneralQuestion: rejects emoji-only and short non-questions', () => {
  assert.equal(isGeneralQuestion('😂😂😂'), false);
  assert.equal(isGeneralQuestion('ок'), false);
  assert.equal(isGeneralQuestion('привет'), false);
  assert.equal(isGeneralQuestion('Завтра в 19:00 встречаемся у офиса как обычно'), false);
});

test('messageHasAnyMention detects @ and text_mention', () => {
  assert.equal(
    messageHasAnyMention(textMessage('Привет @ivan', {
      entities: [{ type: 'mention', offset: 7, length: 5 }],
    })),
    true,
  );
  assert.equal(
    messageHasAnyMention(textMessage('Привет друг', {
      entities: [{
        type: 'text_mention',
        offset: 7,
        length: 4,
        user: { id: 99, is_bot: false, first_name: 'Друг' },
      }],
    })),
    true,
  );
  assert.equal(messageHasAnyMention(textMessage('Привет всем')), false);
});

test('isUrlOnlyMediaCandidate matches standalone video/gallery links', () => {
  assert.equal(
    isUrlOnlyMediaCandidate('https://www.youtube.com/shorts/abcdefghijk'),
    true,
  );
  assert.equal(
    isUrlOnlyMediaCandidate('https://www.instagram.com/p/AbCdEfGhIjK/'),
    true,
  );
  assert.equal(
    isUrlOnlyMediaCandidate('Смотрите https://www.youtube.com/shorts/abcdefghijk'),
    false,
  );
});

test('shouldEnqueueAutoAnswer skips replies, mentions, commands, bot authors, media links', () => {
  assert.equal(shouldEnqueueAutoAnswer(textMessage('Кто знает хороший коворкинг?')), true);

  assert.equal(
    shouldEnqueueAutoAnswer(textMessage('/summary', {})),
    false,
  );
  assert.equal(
    shouldEnqueueAutoAnswer(textMessage('Вопрос?', {
      reply_to_message: textMessage('ранее'),
    })),
    false,
  );
  assert.equal(
    shouldEnqueueAutoAnswer(textMessage('@summary_bot что думаешь?', {
      entities: [{ type: 'mention', offset: 0, length: 12 }],
    })),
    false,
  );
  assert.equal(
    shouldEnqueueAutoAnswer(textMessage('@ivan что думаешь?', {
      entities: [{ type: 'mention', offset: 0, length: 5 }],
    })),
    false,
  );
  assert.equal(
    shouldEnqueueAutoAnswer(textMessage('https://www.youtube.com/shorts/abcdefghijk')),
    false,
  );
  assert.equal(
    shouldEnqueueAutoAnswer(textMessage('бот отвечает', {
      from: { id: 1, is_bot: true, first_name: 'OtherBot' },
    })),
    false,
  );
  assert.equal(shouldEnqueueAutoAnswer(textMessage('просто текст без вопроса')), false);
});

test('activityCancelsPending: reply, forum topic, and non-forum chat', () => {
  const pending = { messageId: 10, messageThreadId: 5 };
  assert.equal(
    activityCancelsPending(pending, { replyToMessageId: 10, isForum: false }),
    true,
  );
  assert.equal(
    activityCancelsPending(pending, { replyToMessageId: 99, messageThreadId: 5, isForum: true }),
    true,
  );
  assert.equal(
    activityCancelsPending(pending, { messageThreadId: 7, isForum: true }),
    false,
  );
  assert.equal(
    activityCancelsPending(pending, { messageThreadId: 7, isForum: false }),
    true,
  );
  assert.equal(
    activityCancelsPending(
      { messageId: 10, messageThreadId: null },
      { messageThreadId: null, isForum: true },
    ),
    true,
  );
});

test('autoAnswerClaimLeaseUntil follows configured lease', () => {
  const now = new Date('2024-03-10T12:00:00.000Z');
  const lease = autoAnswerClaimLeaseUntil(now);
  assert.equal(lease.getTime() - now.getTime(), 180_000);
});

test('ownsAutoAnswerClaim requires matching lease token', () => {
  const lease = new Date('2024-03-10T12:03:00.000Z');
  assert.equal(
    ownsAutoAnswerClaim({ status: 'claimed', claimedUntil: lease }, lease),
    true,
  );
  assert.equal(
    ownsAutoAnswerClaim(
      { status: 'claimed', claimedUntil: new Date('2024-03-10T12:04:00.000Z') },
      lease,
    ),
    false,
  );
  assert.equal(
    ownsAutoAnswerClaim({ status: 'cancelled', claimedUntil: lease }, lease),
    false,
  );
  assert.equal(
    ownsAutoAnswerClaim({ status: 'claimed', claimedUntil: null }, lease),
    false,
  );
});

test('needsOpenAiGeneration skips when answer_text already persisted', () => {
  assert.equal(needsOpenAiGeneration(null), true);
  assert.equal(needsOpenAiGeneration(''), true);
  assert.equal(needsOpenAiGeneration('  '), true);
  assert.equal(needsOpenAiGeneration('Уже готовый ответ'), false);
});

test('auto-answer system prompt stays plain-text and brief', async () => {
  const { buildAutoAnswerSystemPrompt } = await import('../src/ai.js');
  const prompt = buildAutoAnswerSystemPrompt(0);
  assert.match(prompt, /никто не ответил/i);
  assert.match(prompt, /Не используй Markdown/);
  assert.match(prompt, /тёплый, живой и дружелюбный/);
  assert.match(buildAutoAnswerSystemPrompt(100), /не обидно/);
});

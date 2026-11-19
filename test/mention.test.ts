import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMentionPrompt,
  collectMessageImageFileIds,
  isImageGenerationRequest,
  isMemeRequest,
  messageAddressesBot,
  messageMentionsBot,
  messageRepliesToBot,
  quotedContext,
  setBotIdentity,
  stripBotMention,
} from '../src/mention/mention.js';
import { buildMentionSystemPrompt } from '../src/ai/ai.js';
import type { Message } from 'grammy/types';

setBotIdentity(42, 'SummaryBot');

test('detects @username mention entity', () => {
  const message = {
    text: 'Привет @SummaryBot как дела?',
    entities: [{ type: 'mention', offset: 7, length: 11 }],
  } as Message;
  assert.equal(messageMentionsBot(message), true);
  assert.equal(messageAddressesBot(message), true);
});

test('detects text_mention of bot user id', () => {
  const message = {
    text: 'Эй бот, ответь',
    entities: [{ type: 'text_mention', offset: 0, length: 2, user: { id: 42, is_bot: true, first_name: 'B' } }],
  } as Message;
  assert.equal(messageMentionsBot(message), true);
});

test('ignores other mentions', () => {
  const message = {
    text: 'Привет @someone',
    entities: [{ type: 'mention', offset: 7, length: 8 }],
  } as Message;
  assert.equal(messageMentionsBot(message), false);
  assert.equal(messageAddressesBot(message), false);
});

test('detects reply to the bot own message without @mention', () => {
  const message = {
    text: 'а подробнее?',
    reply_to_message: {
      message_id: 9,
      date: 1,
      chat: { id: -1, type: 'supergroup' },
      from: { id: 42, is_bot: true, first_name: 'SummaryBot' },
      text: 'Краткий ответ бота',
    },
  } as Message;
  assert.equal(messageMentionsBot(message), false);
  assert.equal(messageRepliesToBot(message), true);
  assert.equal(messageAddressesBot(message), true);
});

test('ignores reply to another user', () => {
  const message = {
    text: 'согласен',
    reply_to_message: {
      message_id: 8,
      date: 1,
      chat: { id: -1, type: 'supergroup' },
      from: { id: 99, is_bot: false, first_name: 'Аня' },
      text: 'Пойдём',
    },
  } as Message;
  assert.equal(messageRepliesToBot(message), false);
  assert.equal(messageAddressesBot(message), false);
});

test('strips bot mention from prompt text', () => {
  const text = '@SummaryBot нарисуй кота и расскажи шутку';
  const entities = [{ type: 'mention' as const, offset: 0, length: 12 }];
  assert.equal(stripBotMention(text, 'SummaryBot', entities), 'нарисуй кота и расскажи шутку');
});

test('builds prompt with quoted reply context', () => {
  const prompt = buildMentionPrompt('что он имел в виду?', { author: 'Аня', text: 'Сделаем завтра' }, 1500);
  assert.match(prompt, /Цитата \(Аня\):/);
  assert.match(prompt, /Сделаем завтра/);
  assert.match(prompt, /Запрос:\nчто он имел в виду\?/);
  assert.doesNotMatch(prompt, /Контекст/);
});

test('empty preceding leaves quote+request format unchanged', () => {
  const without = buildMentionPrompt('что?', { author: 'Аня', text: 'ок' }, 1500);
  const withEmpty = buildMentionPrompt('что?', { author: 'Аня', text: 'ок' }, 1500, false, []);
  assert.equal(withEmpty, without);
});

test('includes preceding messages before the quote', () => {
  const prompt = buildMentionPrompt(
    'что он имел в виду?',
    { author: 'Аня', text: 'Сделаем завтра' },
    1500,
    false,
    [
      { author: 'Боря', text: 'Кто свободен?' },
      { author: 'Аня', text: 'Я могу после обеда' },
    ],
  );
  assert.equal(
    prompt,
    [
      'Контекст (сообщения до цитаты):',
      '[Боря]: Кто свободен?',
      '[Аня]: Я могу после обеда',
      '',
      'Цитата (Аня):',
      'Сделаем завтра',
      '',
      'Запрос:',
      'что он имел в виду?',
    ].join('\n'),
  );
});

test('includes preceding messages for a plain mention without quote', () => {
  const prompt = buildMentionPrompt(
    'что решили?',
    undefined,
    1500,
    false,
    [
      { author: 'Боря', text: 'Может в пятницу?' },
      { author: 'Аня', text: 'Да, давайте' },
    ],
  );
  assert.equal(
    prompt,
    [
      'Контекст (недавние сообщения):',
      '[Боря]: Может в пятницу?',
      '[Аня]: Да, давайте',
      '',
      'Запрос:',
      'что решили?',
    ].join('\n'),
  );
});

test('plain mention without preceding stays a bare request', () => {
  assert.equal(buildMentionPrompt('привет', undefined, 1500), 'привет');
  assert.equal(buildMentionPrompt('привет', undefined, 1500, false, []), 'привет');
});

test('drops preceding before truncating quote or request when budget is tight', () => {
  const request = 'что имелось в виду?';
  const quote = 'x'.repeat(80);
  // Barely enough for quote+request (budget ≥ 40), little room for preceding.
  const maxChars = `Цитата (Аня):\n${quote}\n\nЗапрос:\n${request}`.length + 10;
  const prompt = buildMentionPrompt(
    request,
    { author: 'Аня', text: quote },
    maxChars,
    false,
    [
      { author: 'Old', text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { author: 'Mid', text: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    ],
  );
  assert.doesNotMatch(prompt, /Контекст/);
  assert.match(prompt, /Цитата \(Аня\):/);
  assert.match(prompt, new RegExp(`Запрос:\\n${request}`));
  assert.ok(prompt.length <= maxChars);
});

test('omits preceding when quote+request budget is under 40', () => {
  const request = 'ок?';
  const quote = 'коротко';
  // Force compact path: header+footer leave < 40 for the quote body.
  const header = 'Цитата (Аня):\n';
  const footer = `\n\nЗапрос:\n${request}`;
  const maxChars = header.length + footer.length + 10;
  const prompt = buildMentionPrompt(
    request,
    { author: 'Аня', text: quote },
    maxChars,
    false,
    [{ author: 'Боря', text: 'контекст который не должен попасть' }],
  );
  assert.doesNotMatch(prompt, /Контекст/);
  assert.doesNotMatch(prompt, /контекст который не должен попасть/);
  assert.match(prompt, /Запрос: ок\?/);
});

test('quote-only mention gets a default request', () => {
  const prompt = buildMentionPrompt('', { author: 'Боря', text: 'Нужен деплой' }, 1500);
  assert.match(prompt, /Нужен деплой/);
  assert.match(prompt, /прокомментируй/i);
});

test('quotedContext reads caption text and keeps image-only quotes', () => {
  assert.deepEqual(
    quotedContext({ caption: 'подпись к фото', from: { id: 1, is_bot: false, first_name: 'Аня' } } as Message),
    { author: 'Аня', text: 'подпись к фото' },
  );
  assert.deepEqual(
    quotedContext({
      photo: [{ file_id: 'small', width: 1, height: 1, file_unique_id: 'a' }, { file_id: 'big', width: 2, height: 2, file_unique_id: 'b' }],
      from: { id: 1, is_bot: false, first_name: 'Аня' },
    } as Message),
    { author: 'Аня', text: '(изображение без подписи)' },
  );
  assert.equal(quotedContext({ photo: [] } as unknown as Message), undefined);
});

test('collectMessageImageFileIds prefers the largest photo and image documents', () => {
  assert.deepEqual(
    collectMessageImageFileIds({
      photo: [
        { file_id: 'small', width: 90, height: 90, file_unique_id: 'a' },
        { file_id: 'large', width: 1280, height: 720, file_unique_id: 'b' },
      ],
    } as Message),
    ['large'],
  );
  assert.deepEqual(
    collectMessageImageFileIds({
      document: { file_id: 'doc', file_unique_id: 'd', mime_type: 'image/png' },
    } as Message),
    ['doc'],
  );
  assert.deepEqual(
    collectMessageImageFileIds({
      document: { file_id: 'pdf', file_unique_id: 'p', mime_type: 'application/pdf' },
    } as Message),
    [],
  );
});

test('image-only context gets a default request', () => {
  assert.match(buildMentionPrompt('', undefined, 1500, true), /изображен/);
});

test('detects meme keywords and ignores plain image requests', () => {
  assert.equal(isMemeRequest('сделай мем про опоздание'), true);
  assert.equal(isMemeRequest('Демотиватор: понедельник'), true);
  assert.equal(isMemeRequest('drake meme about coffee'), true);
  assert.equal(isMemeRequest('две кнопки: спать или ещё серию'), true);
  assert.equal(isMemeRequest('нарисуй кота в космосе'), false);
  assert.equal(isMemeRequest('что такое мемплекс'), false);
});

test('detects explicit image-generation intent without treating memes as image-gen-only', () => {
  assert.equal(isImageGenerationRequest('нарисуй кота в космосе'), true);
  assert.equal(isImageGenerationRequest('Нарисуйте собаку в шляпе'), true);
  assert.equal(isImageGenerationRequest('сгенерируй картинку заката'), true);
  assert.equal(isImageGenerationRequest('сделай изображение города'), true);
  assert.equal(isImageGenerationRequest('generate an image of a cat'), true);
  assert.equal(isImageGenerationRequest('draw me a dragon'), true);
  assert.equal(isImageGenerationRequest('create an image of Mars'), true);
  assert.equal(isImageGenerationRequest('какой курс доллара сегодня?'), false);
  assert.equal(isImageGenerationRequest('привет, как дела?'), false);
  assert.equal(isImageGenerationRequest('что нарисовали на выставке?'), false);
  // Meme keywords stay under isMemeRequest; image-gen helper may still match «нарисуй мем».
  assert.equal(isMemeRequest('сделай мем про понедельник'), true);
  assert.equal(isImageGenerationRequest('сделай мем про понедельник'), false);
});

test('meme system prompt forces friendly meme image instructions', () => {
  const meme = buildMentionSystemPrompt(0, true, 2, false, true);
  assert.match(meme, /мем/i);
  assert.match(meme, /attach_image/);
  assert.match(meme, /доброжелательно/);
  const plain = buildMentionSystemPrompt(0, true, 2, false, false);
  assert.doesNotMatch(plain, /Пользователь просит мем/);
});

test('mention system prompt explains preceding context blocks', () => {
  const plain = buildMentionSystemPrompt(0, true, 2, false, false);
  assert.match(plain, /Контекст \(сообщения до цитаты\)/);
  assert.match(plain, /Контекст \(недавние сообщения\)/);
  assert.match(plain, /Запрос/);
  assert.match(plain, /Цитата/);
  assert.match(plain, /собственные более ранние ответы/i);
  const meme = buildMentionSystemPrompt(0, true, 2, false, true);
  assert.match(meme, /Контекст \(недавние сообщения\)/);
  assert.match(meme, /собственные более ранние ответы/i);
});

test('getBotAuthorLabel uses @username when identity is set', async () => {
  const { getBotAuthorLabel, setBotIdentity } = await import('../src/mention/mention.js');
  setBotIdentity(42, 'Summary_Bot');
  assert.equal(getBotAuthorLabel(), '@summary_bot');
});


test('long quotes never displace the current request and stay within budget', () => {
  const request = 'REQUEST_' + 'r'.repeat(1450);
  const prompt = buildMentionPrompt(request, { author: 'A', text: 'q'.repeat(3000) }, 1500);
  assert.ok(prompt.includes(request));
  assert.ok(prompt.length <= 1500);
  const oversized = buildMentionPrompt('REQUEST_' + 'r'.repeat(3000), { author: 'A', text: 'q'.repeat(3000) }, 1500);
  assert.ok(oversized.includes('REQUEST_'));
  assert.ok(oversized.length <= 1500);
});

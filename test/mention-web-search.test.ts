import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertMentionResponsesResult,
  buildMentionResponsesCreateParams,
  buildMentionResponsesInput,
  buildMentionSystemPrompt,
  buildWebSearchTool,
  mentionShouldUseWebSearchPath,
  mentionUsesWebSearch,
  newsResponsesReasoningOptions,
  responseHasWebSearchCall,
} from '../src/ai/ai.js';
import { config } from '../src/config.js';
import { isImageGenerationRequest, isMemeRequest } from '../src/mention/mention.js';

test('mention system prompt includes soft search rules only when webSearch: true', () => {
  const withSearch = buildMentionSystemPrompt(0, false, 0, false, false, 'gentleman', null, {
    webSearch: true,
  });
  assert.match(withSearch, /веб-поиск|web search/i);
  assert.match(withSearch, /Не выдумывай факты/);
  assert.match(withSearch, /не больше одной реальной ссылки|одной реальной ссылки/i);
  assert.match(withSearch, /шуток|мемов|обычного общения/i);

  const without = buildMentionSystemPrompt(0, false, 0, false, false, 'gentleman', null, {
    webSearch: false,
  });
  assert.doesNotMatch(without, /веб-поиск|web search/i);
  assert.doesNotMatch(without, /Не выдумывай факты/);
});

test('default mention system prompt (no options) does not mandate web search', () => {
  const plain = buildMentionSystemPrompt(0, true, 2, false, false);
  assert.doesNotMatch(plain, /веб-поиск|web search/i);
});

test('meme prompt ignores webSearch option (no search rules)', () => {
  const meme = buildMentionSystemPrompt(0, true, 2, false, true, 'gentleman', null, {
    webSearch: true,
  });
  assert.doesNotMatch(meme, /веб-поиск|web search/i);
  assert.match(meme, /мем/i);
});

test('mention Responses params include web_search and do not force tool_choice', () => {
  const params = buildMentionResponsesCreateParams('Что сегодня по курсу доллара?');
  assert.equal(params.model, config.OPENAI_MODEL);
  assert.deepEqual(params.tools, [buildWebSearchTool()]);
  assert.equal(params.max_output_tokens, config.MENTION_MAX_OUTPUT_TOKENS);
  assert.equal('tool_choice' in params, false);
  assert.match(params.instructions, /веб-поиск|web search/i);
  assert.equal(params.input, 'Что сегодня по курсу доллара?');
  if (/^gpt-6/i.test(params.model)) {
    assert.deepEqual(params.reasoning, { effort: 'low' });
  } else {
    assert.equal('reasoning' in params, false);
  }
  assert.deepEqual(newsResponsesReasoningOptions('gpt-6-sol'), { reasoning: { effort: 'low' } });
});

test('mention Responses input embeds vision images when present', () => {
  const images = [{ mime: 'image/png', data: Buffer.from('abc') }];
  const input = buildMentionResponsesInput('что на фото?', images);
  assert.ok(Array.isArray(input));
  const content = input[0]?.content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0]?.type, 'input_text');
  assert.equal(content[1]?.type, 'input_image');
  assert.match(String(content[1] && 'image_url' in content[1] ? content[1].image_url : ''), /^data:image\/png;base64,/);

  const params = buildMentionResponsesCreateParams('что на фото?', { inputImages: images });
  assert.ok(Array.isArray(params.input));
  assert.match(params.instructions, /изображен/i);
});

test('assertMentionResponsesResult accepts completed response without a search call', () => {
  const text = assertMentionResponsesResult({
    status: 'completed',
    error: null,
    output: [{ type: 'message' }],
    output_text: '  Привет!  ',
  });
  assert.equal(text, 'Привет!');
  assert.equal(responseHasWebSearchCall([{ type: 'message' }]), false);
});

test('assertMentionResponsesResult also accepts successful search output', () => {
  const text = assertMentionResponsesResult({
    status: 'completed',
    error: null,
    output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message' }],
    output_text: 'Курс около 90.',
  });
  assert.equal(text, 'Курс около 90.');
});

test('assertMentionResponsesResult throws on error, incomplete, empty text', () => {
  assert.throws(
    () => assertMentionResponsesResult({
      status: 'completed',
      error: { code: 'server_error', message: 'boom' },
      output_text: 'x',
    }),
    /Mention Responses API error/,
  );
  assert.throws(
    () => assertMentionResponsesResult({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: 'partial',
    }),
    /status is incomplete.*max_output_tokens/,
  );
  assert.throws(
    () => assertMentionResponsesResult({
      status: 'completed',
      output: [{ type: 'message' }],
      output_text: '   ',
    }),
    /Empty mention model response/,
  );
});

test('mentionUsesWebSearch mirrors MENTION_WEB_SEARCH config', () => {
  assert.equal(mentionUsesWebSearch(), config.MENTION_WEB_SEARCH === 'true');
});

test('mentionShouldUseWebSearchPath respects memeMode, forceCompletions, and config gate', () => {
  assert.equal(mentionShouldUseWebSearchPath({}), mentionUsesWebSearch());
  assert.equal(mentionShouldUseWebSearchPath({ memeMode: true }), false);
  assert.equal(mentionShouldUseWebSearchPath({ forceCompletions: true }), false);
  assert.equal(mentionShouldUseWebSearchPath({ memeMode: true, forceCompletions: true }), false);
  // Pure logic: when the config gate is off, path is always false regardless of flags.
  if (!mentionUsesWebSearch()) {
    assert.equal(mentionShouldUseWebSearchPath({ memeMode: false, forceCompletions: false }), false);
  } else {
    assert.equal(mentionShouldUseWebSearchPath({ memeMode: false, forceCompletions: false }), true);
  }
});

test('isImageGenerationRequest detects clear draw/generate intent', () => {
  assert.equal(isImageGenerationRequest('нарисуй кота в космосе'), true);
  assert.equal(isImageGenerationRequest('какой сегодня курс доллара?'), false);
  assert.equal(isImageGenerationRequest('расскажи анекдот'), false);
  assert.equal(isMemeRequest('нарисуй кота в космосе'), false);
  assert.equal(isMemeRequest('сделай мем про кота'), true);
});

test('buildWebSearchTool reuses NEWS_SEARCH_CONTEXT_SIZE by default', () => {
  const tool = buildWebSearchTool();
  assert.equal(tool.type, 'web_search');
  assert.equal(tool.search_context_size, config.NEWS_SEARCH_CONTEXT_SIZE);
  assert.deepEqual(tool.user_location, {
    type: 'approximate',
    country: 'RU',
    timezone: 'Europe/Moscow',
  });
});

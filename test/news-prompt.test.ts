import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNewsResponsesResult,
  buildNewsResponsesCreateParams,
  buildNewsSystemPrompt,
  buildNewsUserPrompt,
  buildNewsWebSearchTool,
  mapResponsesUsage,
  newsModel,
  newsUsesWebSearch,
  responseHasSuccessfulWebSearchCall,
  responseHasWebSearchCall,
} from '../src/ai.js';
import { config } from '../src/config.js';

test('web-search news prompt requires search, one real URL, and forbids invention', () => {
  const prompt = buildNewsSystemPrompt('Игры', { webSearch: true });
  assert.match(prompt, /Игры/);
  assert.match(prompt, /Обязательно используй веб-поиск|web search/i);
  assert.match(prompt, /Не выдумывай факты/);
  assert.match(prompt, /фейковые URL|ссылки/i);
  assert.match(prompt, /24–48|24-48|48 часов/);
  assert.match(prompt, /ровно одну реальную ссылку/i);
  assert.match(prompt, /Не используй Markdown/);
});

test('fallback news prompt does not mandate web search', () => {
  const prompt = buildNewsSystemPrompt('Игры', { webSearch: false });
  assert.match(prompt, /Игры/);
  assert.doesNotMatch(prompt, /Обязательно используй веб-поиск/);
  assert.match(prompt, /Опирайся на свои знания|живого веб-поиска нет/i);
  assert.match(prompt, /Не выдумывай факты/);
  assert.match(prompt, /48 часов/);
  assert.match(prompt, /ограничения памяти|уверенности в факте/i);
  assert.match(prompt, /Не используй Markdown/);
});

test('news user prompt asks for web search only when enabled', () => {
  const withSearch = buildNewsUserPrompt('games', 'Игры', '2026-11-17', { webSearch: true });
  assert.match(withSearch, /веб-поиск/i);
  assert.match(withSearch, /2026-11-17/);

  const withoutSearch = buildNewsUserPrompt('games', 'Игры', '2026-11-17', { webSearch: false });
  assert.doesNotMatch(withoutSearch, /веб-поиск/i);
  assert.match(withoutSearch, /Пришли одну свежую интересную новость/);
});

test('news web_search tool payload uses RU / Moscow and configured context size', () => {
  const tool = buildNewsWebSearchTool();
  assert.equal(tool.type, 'web_search');
  assert.equal(tool.search_context_size, config.NEWS_SEARCH_CONTEXT_SIZE);
  assert.deepEqual(tool.user_location, {
    type: 'approximate',
    country: 'RU',
    timezone: 'Europe/Moscow',
  });
});

test('Responses news params include tools, forced tool_choice, and low reasoning', () => {
  const params = buildNewsResponsesCreateParams('games', 'Игры', '2026-11-17');
  assert.equal(params.model, newsModel());
  assert.deepEqual(params.tools, [buildNewsWebSearchTool()]);
  assert.equal(params.max_output_tokens, config.NEWS_MAX_OUTPUT_TOKENS);
  assert.deepEqual(params.reasoning, { effort: 'low' });
  assert.match(params.instructions, /Обязательно используй веб-поиск/);
  assert.match(params.input, /веб-поиск/i);
  if (config.NEWS_FORCE_WEB_SEARCH === 'true') {
    assert.equal(params.tool_choice, 'required');
  }
});

test('mapResponsesUsage maps input_tokens/output_tokens into buildAiUsage', () => {
  const usage = mapResponsesUsage('news-model', {
    input_tokens: 1_000_000,
    output_tokens: 0,
  });
  assert.equal(usage.model, 'news-model');
  assert.equal(usage.promptTokens, 1_000_000);
  assert.equal(usage.completionTokens, 0);
  assert.equal(usage.estimatedCostUsd, 2);
});

test('responseHasWebSearchCall and successful completed check', () => {
  assert.equal(responseHasWebSearchCall([{ type: 'message' }]), false);
  assert.equal(responseHasWebSearchCall([{ type: 'web_search_call', status: 'failed' }]), true);
  assert.equal(responseHasSuccessfulWebSearchCall([{ type: 'web_search_call', status: 'failed' }]), false);
  assert.equal(
    responseHasSuccessfulWebSearchCall([{ type: 'web_search_call', status: 'completed' }, { type: 'message' }]),
    true,
  );
  assert.equal(responseHasSuccessfulWebSearchCall(undefined), false);
});

test('assertNewsResponsesResult accepts completed successful search output', () => {
  const text = assertNewsResponsesResult({
    status: 'completed',
    error: null,
    output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message' }],
    output_text: '  🎮 Новость  ',
  }, { forceWebSearch: true });
  assert.equal(text, '🎮 Новость');
});

test('assertNewsResponsesResult throws on error, incomplete, failed search, empty text', () => {
  assert.throws(
    () => assertNewsResponsesResult({
      status: 'completed',
      error: { code: 'server_error', message: 'boom' },
      output_text: 'x',
    }),
    /News Responses API error/,
  );
  assert.throws(
    () => assertNewsResponsesResult({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'web_search_call', status: 'completed' }],
      output_text: 'partial',
    }),
    /status is incomplete.*max_output_tokens/,
  );
  assert.throws(
    () => assertNewsResponsesResult({
      status: 'completed',
      output: [{ type: 'message' }],
      output_text: 'no search',
    }, { forceWebSearch: true }),
    /no web_search_call ran/,
  );
  assert.throws(
    () => assertNewsResponsesResult({
      status: 'completed',
      output: [{ type: 'web_search_call', status: 'failed' }],
      output_text: 'search failed',
    }, { forceWebSearch: true }),
    /did not complete successfully/,
  );
  assert.throws(
    () => assertNewsResponsesResult({
      status: 'completed',
      output: [{ type: 'web_search_call', status: 'completed' }],
      output_text: '   ',
    }, { forceWebSearch: true }),
    /Empty news model response/,
  );
});

test('newsUsesWebSearch mirrors NEWS_WEB_SEARCH config (default Responses path)', () => {
  assert.equal(newsUsesWebSearch(), config.NEWS_WEB_SEARCH === 'true');
});

test('newsModel falls back to OPENAI_MODEL when OPENAI_NEWS_MODEL is empty', () => {
  assert.equal(newsModel(), config.OPENAI_NEWS_MODEL.trim() || config.OPENAI_MODEL);
});

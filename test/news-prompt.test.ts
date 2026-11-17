import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNewsSystemPrompt,
  buildNewsUserPrompt,
  buildNewsWebSearchTool,
  mapResponsesUsage,
  newsModel,
  responseHasWebSearchCall,
} from '../src/ai.js';
import { config } from '../src/config.js';

test('news prompt includes sphere, web search, freshness window, and forbids invention', () => {
  const prompt = buildNewsSystemPrompt('Игры');
  assert.match(prompt, /Игры/);
  assert.match(prompt, /веб-поиск|web search/i);
  assert.match(prompt, /Не выдумывай факты/);
  assert.match(prompt, /фейковые URL|ссылки/i);
  assert.match(prompt, /24–48|24-48|48 часов/);
  assert.match(prompt, /одну реальную ссылку|ровно одну реальную ссылку/i);
  assert.match(prompt, /Не используй Markdown/);
});

test('news user prompt asks for web search and includes Moscow date', () => {
  const prompt = buildNewsUserPrompt('games', 'Игры', '2026-11-17');
  assert.match(prompt, /Игры/);
  assert.match(prompt, /games/);
  assert.match(prompt, /2026-11-17/);
  assert.match(prompt, /веб-поиск/i);
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

test('responseHasWebSearchCall detects web_search_call items', () => {
  assert.equal(responseHasWebSearchCall([{ type: 'message' }]), false);
  assert.equal(responseHasWebSearchCall([{ type: 'web_search_call' }, { type: 'message' }]), true);
  assert.equal(responseHasWebSearchCall(undefined), false);
});

test('newsModel falls back to OPENAI_MODEL when OPENAI_NEWS_MODEL is empty', () => {
  assert.equal(newsModel(), config.OPENAI_NEWS_MODEL.trim() || config.OPENAI_MODEL);
});

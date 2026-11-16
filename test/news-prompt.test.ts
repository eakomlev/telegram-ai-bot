import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNewsSystemPrompt } from '../src/ai.js';

test('news prompt includes sphere and forbids invention', () => {
  const prompt = buildNewsSystemPrompt('Игры');
  assert.match(prompt, /Игры/);
  assert.match(prompt, /Не выдумывай факты/);
  assert.match(prompt, /фейковые URL|ссылки/i);
  assert.match(prompt, /48 часов/);
  assert.match(prompt, /Не используй Markdown/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGifReactionSystemPrompt } from '../src/ai.js';
import { pickRandomUrl } from '../src/giphy.js';
import { parseSelection } from '../src/summary.js';

test('gif reaction prompt asks for JSON search query', () => {
  const prompt = buildGifReactionSystemPrompt(0);
  assert.match(prompt, /Giphy/);
  assert.match(prompt, /query/);
  assert.match(prompt, /caption/);
  assert.match(prompt, /JSON/);
});

test('parseSelection accepts /gif-sized counts', () => {
  assert.deepEqual(parseSelection('40', 40, 80, 30, '/gif'), { kind: 'count', count: 40 });
  assert.throws(() => parseSelection('500', 40, 80, 30, '/gif'), /\/gif/);
});

test('pickRandomUrl returns undefined for empty list', () => {
  assert.equal(pickRandomUrl([]), undefined);
  assert.equal(pickRandomUrl(['https://example.com/a.mp4']), 'https://example.com/a.mp4');
});

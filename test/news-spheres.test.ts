import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isNewsSphereId,
  NEWS_SPHERES,
  pickRandomSphere,
  sanitizeSpheres,
  sphereLabel,
} from '../src/news-spheres.js';

test('catalog has fixed ids and Russian labels', () => {
  assert.equal(NEWS_SPHERES.length, 15);
  assert.ok(isNewsSphereId('ai'));
  assert.equal(sphereLabel('ai'), 'ИИ / нейросети');
  assert.equal(sphereLabel('it'), 'IT / технологии');
  assert.equal(sphereLabel('memes'), 'Мемы и интернет-культура');
  assert.equal(isNewsSphereId('crypto'), false);
});

test('sanitizeSpheres drops unknowns and duplicates, keeps order', () => {
  assert.deepEqual(sanitizeSpheres(['games', 'nope', 'games', 'food']), ['games', 'food']);
  assert.deepEqual(sanitizeSpheres([]), []);
});

test('pickRandomSphere returns undefined for empty and picks from list', () => {
  assert.equal(pickRandomSphere([]), undefined);
  assert.equal(pickRandomSphere(['space'], () => 0), 'space');
  assert.equal(pickRandomSphere(['it', 'ai', 'games'], () => 0.99), 'games');
});

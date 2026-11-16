import assert from 'node:assert/strict';
import test from 'node:test';
import { cycleDefaultCount, cycleMediaCooldown, cycleSarcasmLevel, defaultChatSettings, formatSettings } from '../src/chat-settings.js';
import { buildSummarySystemPrompt } from '../src/ai.js';

test('cycles default message counts within max', () => {
  assert.equal(cycleDefaultCount(100), 200);
  assert.equal(cycleDefaultCount(1000), 50);
});

test('cycles media cooldown steps', () => {
  assert.equal(cycleMediaCooldown(10), 15);
  assert.equal(cycleMediaCooldown(30), 60);
  assert.equal(cycleMediaCooldown(300), 10);
});

test('cycles sarcasm level from 0 to 100', () => {
  assert.equal(cycleSarcasmLevel(0), 25);
  assert.equal(cycleSarcasmLevel(75), 100);
  assert.equal(cycleSarcasmLevel(100), 0);
});

test('defaults and format mention admin-only controls', () => {
  const settings = defaultChatSettings();
  const text = formatSettings(settings);
  assert.match(text, /Саммари только админам/);
  assert.match(text, /Автозагрузка видео/);
  assert.match(text, /Сарказм:/);
  assert.match(text, /Ежедневная новость: выкл/);
  assert.match(text, /Сферы новостей: не выбраны/);
  assert.match(text, new RegExp(String(settings.defaultMessageCount)));
});

test('formatSettings lists selected news spheres', () => {
  const text = formatSettings({
    ...defaultChatSettings(),
    newsEnabled: true,
    newsSpheres: ['ai', 'games'],
  });
  assert.match(text, /Ежедневная новость: вкл/);
  assert.match(text, /ИИ \/ нейросети/);
  assert.match(text, /Игры/);
});

test('summary prompt stays factual and softens high sarcasm', () => {
  assert.match(buildSummarySystemPrompt(0), /тёплый, живой и дружелюбный/);
  assert.match(buildSummarySystemPrompt(0), /🎬 Коротко/);
  assert.match(buildSummarySystemPrompt(0), /досугового чата коллег/);
  assert.match(buildSummarySystemPrompt(0), /друг, который прочитал весь чат/);
  assert.match(buildSummarySystemPrompt(100), /не обидно/);
  assert.match(buildSummarySystemPrompt(100), /Не придумывай факты/);
});

test('verse summary prompt is a separate humorous poem brief', () => {
  const prompt = buildSummarySystemPrompt(0, 'verse');
  assert.match(prompt, /талантливый поэт/);
  assert.match(prompt, /четверостиший/);
  assert.match(prompt, /Не придумывай события/);
  assert.doesNotMatch(prompt, /🎬 Коротко/);
  assert.match(prompt, /тёплый, живой и дружелюбный/);
});

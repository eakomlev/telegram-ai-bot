import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAutoAnswerSystemPrompt,
  buildGifReactionSystemPrompt,
  buildMentionSystemPrompt,
  buildSummarySystemPrompt,
} from '../src/ai/ai.js';
import {
  cycleDefaultCount,
  cycleMediaCooldown,
  cycleResponseTone,
  cycleSarcasmLevel,
  defaultChatSettings,
  formatSettings,
  sanitizeResponseTone,
} from '../src/chat/chat-settings.js';

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

test('cycles response tone and wraps to gentleman', () => {
  assert.equal(cycleResponseTone('gentleman'), 'pacanchik');
  assert.equal(cycleResponseTone('pacanchik'), 'derzkiy');
  assert.equal(cycleResponseTone('derzkiy'), 'gentleman');
});

test('sanitizeResponseTone falls back to gentleman', () => {
  assert.equal(sanitizeResponseTone('pacanchik'), 'pacanchik');
  assert.equal(sanitizeResponseTone('derzkiy'), 'derzkiy');
  assert.equal(sanitizeResponseTone('unknown'), 'gentleman');
  assert.equal(sanitizeResponseTone(undefined), 'gentleman');
  assert.equal(sanitizeResponseTone(null), 'gentleman');
});

test('defaults and format mention admin-only controls', () => {
  const settings = defaultChatSettings();
  assert.equal(settings.autoAnswerEnabled, false);
  assert.equal(settings.responseTone, 'gentleman');
  const text = formatSettings(settings);
  assert.match(text, /Саммари только админам/);
  assert.match(text, /Автозагрузка видео/);
  assert.match(text, /Сарказм:/);
  assert.match(text, /Тон ответа: Джентльмен/);
  assert.match(text, /Автоответ на вопросы без ответа: выкл/);
  assert.doesNotMatch(text, /Персонализация/);
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

test('formatSettings shows response tone label', () => {
  assert.match(
    formatSettings({ ...defaultChatSettings(), responseTone: 'pacanchik' }),
    /Тон ответа: Пацанчик/,
  );
  assert.match(
    formatSettings({ ...defaultChatSettings(), responseTone: 'derzkiy' }),
    /Тон ответа: Дерзкий/,
  );
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

test('summary prompt includes response tone only when not gentleman', () => {
  assert.doesNotMatch(buildSummarySystemPrompt(0, 'plain', 'gentleman'), /Тон ответа —/);
  assert.match(buildSummarySystemPrompt(0, 'plain', 'pacanchik'), /пацанчик/);
  const derzkiy = buildSummarySystemPrompt(0, 'plain', 'derzkiy');
  assert.match(derzkiy, /дерзкий/);
  assert.match(derzkiy, /супер-дерзко/);
  assert.match(derzkiy, /остроумно/);
});

test('mention and auto-answer prompts respect response tone', () => {
  assert.doesNotMatch(buildMentionSystemPrompt(0, true, 2, false, false, 'gentleman'), /Тон ответа —/);
  assert.match(buildMentionSystemPrompt(0, true, 2, false, false, 'pacanchik'), /пацанчик/);
  assert.match(buildMentionSystemPrompt(0, true, 2, false, true, 'derzkiy'), /дерзкий/);

  assert.doesNotMatch(buildAutoAnswerSystemPrompt(0, 'gentleman'), /Тон ответа —/);
  assert.match(buildAutoAnswerSystemPrompt(0, 'pacanchik'), /пацанчик/);
  assert.match(buildAutoAnswerSystemPrompt(0, 'derzkiy'), /дерзкий/);
});

test('gif reaction prompt respects response tone', () => {
  assert.doesNotMatch(buildGifReactionSystemPrompt(0, 'gentleman'), /Тон ответа —/);
  assert.match(buildGifReactionSystemPrompt(0, 'pacanchik'), /пацанчик/);
  assert.match(buildGifReactionSystemPrompt(0, 'derzkiy'), /дерзкий/);
});

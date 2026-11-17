import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import {
  botDescription,
  botShortDescription,
  privateWelcome,
  welcomeImageBotFatherPath,
  welcomeImagePath,
} from '../src/bot-profile.js';

test('BotFather short description fits Telegram limit', () => {
  assert.ok(botShortDescription.length > 0);
  assert.ok(botShortDescription.length <= 120);
});

test('BotFather description fits Telegram limit', () => {
  assert.ok(botDescription.length > 0);
  assert.ok(botDescription.length <= 512);
});

test('private welcome caption fits Telegram photo caption limit', () => {
  assert.ok(privateWelcome.length > 0);
  assert.ok(privateWelcome.length <= 1024);
});

test('welcome images are present in assets', async () => {
  await access(welcomeImagePath);
  await access(welcomeImageBotFatherPath);
});

import type { Context } from 'grammy';
import { config } from '../config.js';
import { getChatMemory, withChatMemoryPins } from '../core/db.js';
import { splitReply } from '../summary/summary.js';
import {
  appendPinnedFact,
  forgetPinnedFact,
  formatMemoryReply,
} from './chat-memory.js';
import { requireChatAdmin } from './settings-ui.js';

function commandArgument(ctx: Context): string {
  return typeof ctx.match === 'string' ? ctx.match : '';
}

export async function replyWithChatMemory(ctx: Context): Promise<void> {
  if (!(await requireChatAdmin(ctx))) return;
  const memory = await getChatMemory(ctx.chat!.id);
  const text = formatMemoryReply(memory.body, memory.pinned);
  for (const part of splitReply(text, config.TELEGRAM_MAX_MESSAGE_LENGTH)) {
    await ctx.reply(part);
  }
}

export async function rememberChatFact(ctx: Context): Promise<void> {
  if (!(await requireChatAdmin(ctx))) return;
  const fact = commandArgument(ctx).trim();
  if (!fact) {
    await ctx.reply('Напишите факт после команды: /remember текст');
    return;
  }

  let failure: 'empty' | 'full' | undefined;
  const status = await withChatMemoryPins(ctx.chat!.id, (pinned) => {
    const result = appendPinnedFact(pinned, fact, config.CHAT_MEMORY_PIN_MAX_CHARS);
    if (!result.ok) {
      failure = result.reason;
      return null;
    }
    return result.pinned;
  });
  if (status === 'conflict') {
    await ctx.reply('Список фактов только что изменился, попробуйте ещё раз.');
    return;
  }
  if (failure === 'full') {
    await ctx.reply('Список закреплённых фактов заполнен, ничего не сохранено.');
    return;
  }
  if (failure === 'empty') {
    await ctx.reply('Напишите факт после команды: /remember текст');
    return;
  }
  await ctx.reply('Запомнил.');
}

export async function forgetChatFact(ctx: Context): Promise<void> {
  if (!(await requireChatAdmin(ctx))) return;
  const arg = commandArgument(ctx).trim();
  if (arg !== '' && !/^\d+$/.test(arg)) {
    await ctx.reply('Использование: /forget — очистить все факты; /forget N — удалить факт номер N из /memory.');
    return;
  }

  let failure: 'missing' | 'usage' | undefined;
  let removed: 'all' | number | undefined;
  const status = await withChatMemoryPins(ctx.chat!.id, (pinned) => {
    const result = forgetPinnedFact(pinned, arg);
    if (!result.ok) {
      failure = result.reason;
      return null;
    }
    removed = result.removed;
    return result.pinned;
  });
  if (status === 'conflict') {
    await ctx.reply('Список фактов только что изменился, попробуйте ещё раз.');
    return;
  }
  if (failure === 'usage') {
    await ctx.reply('Использование: /forget — очистить все факты; /forget N — удалить факт номер N из /memory.');
    return;
  }
  if (failure === 'missing') {
    await ctx.reply('Такого факта нет.');
    return;
  }
  if (removed === 'all') {
    await ctx.reply('Закреплённые факты очищены. Память модели не трогал.');
    return;
  }
  await ctx.reply(`Удалил факт ${removed}.`);
}

import { InlineKeyboard, type Context } from 'grammy';
import { config, ownerUserId } from '../config.js';
import { startStatus } from '../core/status.js';
import { splitReply } from '../summary/summary.js';
import { formatChatGcReport } from './chat-gc-report.js';
import { runChatGcNow, type ChatGcReport } from './chat-gc-scheduler.js';

export const CHAT_CHECK_CALLBACK_PREFIX = 'gc:';

const CONFIRM_TEXT =
  'Проверю все известные группы. Если бот больше не в чате, удалю его сообщения, память, настройки и статистику из базы. Запустить?';
const CANCEL_LABEL = 'Отмена';
const RUN_LABEL = 'Запустить';
const CANCELLED_TEXT = 'Отменено.';
const OWNER_ONLY_ALERT = 'Только для владельца бота';
const DISABLED_TEXT = 'Проверка чатов выключена (CHAT_GC_ENABLED).';
const BUSY_TEXT = 'Проверка групп уже выполняется.';
const GROUP_ONLY_TEXT = 'Команда доступна только владельцу в личных сообщениях.';

export type ChatCheckCallbackAction = 'run' | 'cancel';

export function parseChatCheckCallbackData(data: string): ChatCheckCallbackAction | null {
  if (!data.startsWith(CHAT_CHECK_CALLBACK_PREFIX)) return null;
  const rest = data.slice(CHAT_CHECK_CALLBACK_PREFIX.length);
  if (rest === 'run' || rest === 'cancel') return rest;
  return null;
}

export function buildChatCheckKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(RUN_LABEL, `${CHAT_CHECK_CALLBACK_PREFIX}run`)
    .text(CANCEL_LABEL, `${CHAT_CHECK_CALLBACK_PREFIX}cancel`);
}

function isChatCheckOwner(ctx: Context): boolean {
  return Boolean(ownerUserId && ctx.from?.id === ownerUserId && !ctx.msg?.sender_chat);
}

async function replyReport(ctx: Context, report: ChatGcReport) {
  const text = formatChatGcReport(report);
  for (const part of splitReply(text, config.TELEGRAM_MAX_MESSAGE_LENGTH)) {
    await ctx.reply(part, { link_preview_options: { is_disabled: true } });
  }
}

export async function replyWithChatCheckConfirm(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private' || !isChatCheckOwner(ctx)) {
    if (ctx.chat?.type !== 'private') await ctx.reply(GROUP_ONLY_TEXT).catch(() => {});
    return;
  }
  if (!ownerUserId) {
    await ctx.reply('Задайте OWNER_USER_ID в .env и перезапустите бота.');
    return;
  }
  if (config.CHAT_GC_ENABLED !== 'true') {
    await ctx.reply(DISABLED_TEXT);
    return;
  }
  await ctx.reply(CONFIRM_TEXT, { reply_markup: buildChatCheckKeyboard() });
}

/** Handle `gc:` callbacks. Returns true when the update was consumed. */
export async function handleChatCheckCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(CHAT_CHECK_CALLBACK_PREFIX)) return false;

  if (ctx.chat?.type !== 'private' || !isChatCheckOwner(ctx)) {
    await ctx.answerCallbackQuery({ text: OWNER_ONLY_ALERT, show_alert: true });
    return true;
  }
  if (config.CHAT_GC_ENABLED !== 'true') {
    await ctx.answerCallbackQuery({ text: DISABLED_TEXT, show_alert: true });
    return true;
  }

  const action = parseChatCheckCallbackData(data);
  if (!action) {
    await ctx.answerCallbackQuery();
    return true;
  }
  if (action === 'cancel') {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(CANCELLED_TEXT);
    } catch {
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply(CANCELLED_TEXT).catch(() => {});
    }
    return true;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Запускаю проверку групп.').catch(() => {});
  const status = await startStatus(ctx, '⏳ Проверяю группы…');
  try {
    const outcome = await runChatGcNow(ctx.api);
    await status.clear();
    if (outcome === 'busy') {
      await ctx.reply(BUSY_TEXT);
      return true;
    }
    if (outcome === 'disabled') {
      await ctx.reply(DISABLED_TEXT);
      return true;
    }
    await replyReport(ctx, outcome);
  } catch (error) {
    console.error('Manual chat check failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    await status.fail('Не удалось проверить чаты. Попробуйте позже.');
  }
  return true;
}

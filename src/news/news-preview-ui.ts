import { InlineKeyboard, type Context } from 'grammy';
import { allowedChatIds, config, ownerUserId } from '../config.js';
import { listChatMemoryRefreshTargets } from '../core/db.js';
import { startStatus } from '../core/status.js';
import { splitReply } from '../summary/summary.js';
import { filterMemoryRefreshChatIds } from '../chat/chat-memory-refresh-ui.js';
import { previewNews } from './news.js';

export const NEWS_PREVIEW_CALLBACK_PREFIX = 'nws:';

const PICKER_TEXT = 'Выберите группу. Пробная новость придёт сюда и в чат не отправится:';
const EMPTY_PICKER_TEXT = 'Нет групп для пробной новости (проверьте ALLOWED_CHAT_IDS).';
const CANCEL_LABEL = 'Отмена';
const CANCELLED_TEXT = 'Отменено.';
const OWNER_ONLY_ALERT = 'Только для владельца бота';
const BUSY_TEXT = 'Пробная новость для этого чата уже собирается.';
const NOT_ALLOWED_TEXT = 'Этот чат не входит в ALLOWED_CHAT_IDS.';
const GROUP_ONLY_TEXT = 'Команда доступна только владельцу в личных сообщениях.';
const BUTTON_TEXT_MAX = 64;
const PICKER_LIMIT = 40;

export type NewsPreviewCallbackAction =
  | { type: 'run'; chatId: number }
  | { type: 'cancel' };

export function parseNewsPreviewCallbackData(data: string): NewsPreviewCallbackAction | null {
  if (!data.startsWith(NEWS_PREVIEW_CALLBACK_PREFIX)) return null;
  const rest = data.slice(NEWS_PREVIEW_CALLBACK_PREFIX.length);
  if (rest === 'cancel') return { type: 'cancel' };
  if (!rest.startsWith('run:')) return null;
  const idStr = rest.slice(4);
  if (!/^-?\d+$/.test(idStr)) return null;
  const chatId = Number(idStr);
  if (!Number.isSafeInteger(chatId)) return null;
  return { type: 'run', chatId };
}

export function truncateNewsPreviewButtonLabel(label: string, max = BUTTON_TEXT_MAX): string {
  if (label.length <= max) return label;
  if (max <= 1) return '…';
  return `${label.slice(0, max - 1)}…`;
}

export function buildNewsPreviewPickerKeyboard(
  chats: Array<{ chatId: number; label: string }>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    keyboard
      .text(
        truncateNewsPreviewButtonLabel(chat.label),
        `${NEWS_PREVIEW_CALLBACK_PREFIX}run:${chat.chatId}`,
      )
      .row();
  }
  keyboard.text(CANCEL_LABEL, `${NEWS_PREVIEW_CALLBACK_PREFIX}cancel`);
  return keyboard;
}

function isNewsPreviewOwner(ctx: Context): boolean {
  return Boolean(ownerUserId && ctx.from?.id === ownerUserId && !ctx.msg?.sender_chat);
}

async function chatLabel(ctx: Context, chatId: number): Promise<string> {
  try {
    const chat = await ctx.api.getChat(chatId);
    const title = 'title' in chat && chat.title ? chat.title : undefined;
    return title ? `${title} (${chatId})` : String(chatId);
  } catch {
    return String(chatId);
  }
}

export async function replyWithNewsPreviewPicker(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private' || !isNewsPreviewOwner(ctx)) {
    if (ctx.chat?.type !== 'private') await ctx.reply(GROUP_ONLY_TEXT).catch(() => {});
    return;
  }
  if (!ownerUserId) {
    await ctx.reply('Задайте OWNER_USER_ID в .env и перезапустите бота.');
    return;
  }
  const chatIds = filterMemoryRefreshChatIds(await listChatMemoryRefreshTargets(), allowedChatIds);
  if (!chatIds.length) {
    await ctx.reply(EMPTY_PICKER_TEXT);
    return;
  }
  const shown = chatIds.slice(0, PICKER_LIMIT);
  const chats = await Promise.all(
    shown.map(async (chatId) => ({ chatId, label: await chatLabel(ctx, chatId) })),
  );
  chats.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  const note = chatIds.length > shown.length
    ? `\n\nПоказаны первые ${PICKER_LIMIT} из ${chatIds.length}.`
    : '';
  await ctx.reply(PICKER_TEXT + note, { reply_markup: buildNewsPreviewPickerKeyboard(chats) });
}

/** Handle `nws:` callbacks. Returns true when the update was consumed. */
export async function handleNewsPreviewCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(NEWS_PREVIEW_CALLBACK_PREFIX)) return false;

  if (ctx.chat?.type !== 'private' || !isNewsPreviewOwner(ctx)) {
    await ctx.answerCallbackQuery({ text: OWNER_ONLY_ALERT, show_alert: true });
    return true;
  }

  const action = parseNewsPreviewCallbackData(data);
  if (!action) {
    await ctx.answerCallbackQuery();
    return true;
  }
  if (action.type === 'cancel') {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(CANCELLED_TEXT);
    } catch {
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply(CANCELLED_TEXT).catch(() => {});
    }
    return true;
  }

  if (!filterMemoryRefreshChatIds([action.chatId], allowedChatIds).length) {
    await ctx.answerCallbackQuery({ text: NOT_ALLOWED_TEXT, show_alert: true });
    return true;
  }

  await ctx.answerCallbackQuery();
  const label = await chatLabel(ctx, action.chatId);
  await ctx.editMessageText(`Выбрано: ${label}`).catch(() => {});
  const status = await startStatus(ctx, '⏳ Собираю пробную новость…');
  try {
    const outcome = await previewNews(action.chatId);
    await status.clear();
    let text = BUSY_TEXT;
    if (outcome.status === 'empty') {
      text = `В чате ${label} ещё нет памяти. Новость не из чего собрать, в чат ничего не отправлял.`;
    } else if (outcome.status === 'ok') {
      text = `Пробная новость для ${label}. В чат не отправлял.\n\n${outcome.text}`;
    }
    for (const part of splitReply(text, config.TELEGRAM_MAX_MESSAGE_LENGTH)) {
      await ctx.reply(part, { link_preview_options: { is_disabled: true } });
    }
  } catch (error) {
    console.error('News preview failed', {
      chatId: action.chatId,
      message: error instanceof Error ? error.message : String(error),
    });
    await status.fail('Не удалось собрать пробную новость. Попробуйте позже.');
  }
  return true;
}

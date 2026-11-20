import { InlineKeyboard, type Api, type Context } from 'grammy';
import { allowedChatIds, config, ownerUserId } from '../config.js';
import { getChatMemory, listChatMemoryRefreshTargets } from '../core/db.js';
import { startStatus } from '../core/status.js';
import { splitReply } from '../summary/summary.js';
import { formatMemoryReply } from './chat-memory.js';
import { refreshChatMemoryNow } from './chat-memory-scheduler.js';

export const MEMORY_REFRESH_CALLBACK_PREFIX = 'memr:';

const PICKER_TEXT = 'Выберите группу. Память пересчитается по сообщениям за последние 3 дня:';
const EMPTY_PICKER_TEXT = 'Нет групп для обновления памяти (проверьте ALLOWED_CHAT_IDS).';
const CANCEL_LABEL = 'Отмена';
const CANCELLED_TEXT = 'Отменено.';
const OWNER_ONLY_ALERT = 'Только для владельца бота';
const GLOBAL_OFF_TEXT = 'Память чата выключена (CHAT_MEMORY_ENABLED).';
const BUSY_TEXT = 'Обновление памяти этого чата уже выполняется.';
const NOT_ALLOWED_TEXT = 'Этот чат не входит в ALLOWED_CHAT_IDS.';
const GROUP_ONLY_TEXT = 'Команда доступна только владельцу в личных сообщениях.';
const BUTTON_TEXT_MAX = 64;
const PICKER_LIMIT = 40;

export type MemoryRefreshCallbackAction =
  | { type: 'run'; chatId: number }
  | { type: 'cancel' };

export function parseMemoryRefreshCallbackData(data: string): MemoryRefreshCallbackAction | null {
  if (!data.startsWith(MEMORY_REFRESH_CALLBACK_PREFIX)) return null;
  const rest = data.slice(MEMORY_REFRESH_CALLBACK_PREFIX.length);
  if (rest === 'cancel') return { type: 'cancel' };
  if (!rest.startsWith('run:')) return null;
  const idStr = rest.slice(4);
  if (!/^-?\d+$/.test(idStr)) return null;
  const chatId = Number(idStr);
  if (!Number.isSafeInteger(chatId)) return null;
  return { type: 'run', chatId };
}

export function truncateMemoryRefreshButtonLabel(label: string, max = BUTTON_TEXT_MAX): string {
  if (label.length <= max) return label;
  if (max <= 1) return '…';
  return `${label.slice(0, max - 1)}…`;
}

export function buildMemoryRefreshPickerKeyboard(
  chats: Array<{ chatId: number; label: string }>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    keyboard
      .text(
        truncateMemoryRefreshButtonLabel(chat.label),
        `${MEMORY_REFRESH_CALLBACK_PREFIX}run:${chat.chatId}`,
      )
      .row();
  }
  keyboard.text(CANCEL_LABEL, `${MEMORY_REFRESH_CALLBACK_PREFIX}cancel`);
  return keyboard;
}

export function filterMemoryRefreshChatIds(chatIds: number[], allowlist = allowedChatIds): number[] {
  const groups = chatIds.filter((id) => id < 0);
  if (!allowlist.size) return groups;
  return groups.filter((id) => allowlist.has(String(id)));
}

function isMemoryRefreshOwner(ctx: Context): boolean {
  return Boolean(ownerUserId && ctx.from?.id === ownerUserId && !ctx.msg?.sender_chat);
}

async function chatLabel(api: Api, chatId: number): Promise<string> {
  try {
    const chat = await api.getChat(chatId);
    const title = 'title' in chat && chat.title ? chat.title : undefined;
    return title ? `${title} (${chatId})` : String(chatId);
  } catch {
    return String(chatId);
  }
}

function resultText(
  status: Awaited<ReturnType<typeof refreshChatMemoryNow>>,
  memory: { body: string; pinned: string },
): string {
  if (status === 'busy') return BUSY_TEXT;
  if (status === 'empty') return 'За последние 3 дня в этом чате нет сообщений людей. Память не менял.';
  if (status === 'blank') return 'Модель вернула пустой текст. Память не менял.';
  if (status === 'lost') return 'Обновление не сохранилось: его перехватил другой проход. Попробуйте ещё раз.';
  return `Память обновлена по сообщениям за последние 3 дня. Закреплённые факты не менял.\n\n${formatMemoryReply(memory.body, memory.pinned)}`;
}

export async function replyWithMemoryRefreshPicker(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private' || !isMemoryRefreshOwner(ctx)) {
    if (ctx.chat?.type !== 'private') await ctx.reply(GROUP_ONLY_TEXT).catch(() => {});
    return;
  }
  if (!ownerUserId) {
    await ctx.reply('Задайте OWNER_USER_ID в .env и перезапустите бота.');
    return;
  }
  if (config.CHAT_MEMORY_ENABLED !== 'true') {
    await ctx.reply(GLOBAL_OFF_TEXT);
    return;
  }
  const chatIds = filterMemoryRefreshChatIds(await listChatMemoryRefreshTargets());
  if (!chatIds.length) {
    await ctx.reply(EMPTY_PICKER_TEXT);
    return;
  }
  const shown = chatIds.slice(0, PICKER_LIMIT);
  const chats = await Promise.all(
    shown.map(async (chatId) => ({ chatId, label: await chatLabel(ctx.api, chatId) })),
  );
  chats.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  const note = chatIds.length > shown.length
    ? `\n\nПоказаны первые ${PICKER_LIMIT} из ${chatIds.length}.`
    : '';
  await ctx.reply(PICKER_TEXT + note, { reply_markup: buildMemoryRefreshPickerKeyboard(chats) });
}

/** Handle `memr:` callbacks. Returns true when the update was consumed. */
export async function handleMemoryRefreshCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(MEMORY_REFRESH_CALLBACK_PREFIX)) return false;

  if (ctx.chat?.type !== 'private' || !isMemoryRefreshOwner(ctx)) {
    await ctx.answerCallbackQuery({ text: OWNER_ONLY_ALERT, show_alert: true });
    return true;
  }
  if (config.CHAT_MEMORY_ENABLED !== 'true') {
    await ctx.answerCallbackQuery({ text: GLOBAL_OFF_TEXT, show_alert: true });
    return true;
  }

  const action = parseMemoryRefreshCallbackData(data);
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

  if (!filterMemoryRefreshChatIds([action.chatId]).length) {
    await ctx.answerCallbackQuery({ text: NOT_ALLOWED_TEXT, show_alert: true });
    return true;
  }

  await ctx.answerCallbackQuery();
  const label = await chatLabel(ctx.api, action.chatId);
  await ctx.editMessageText(`Выбрано: ${label}`).catch(() => {});
  const status = await startStatus(ctx, '⏳ Обновляю память за последние 3 дня…');
  try {
    const outcome = await refreshChatMemoryNow(action.chatId);
    const memory = outcome === 'updated' ? await getChatMemory(action.chatId) : { body: '', pinned: '' };
    await status.clear();
    const text = resultText(outcome, memory);
    for (const part of splitReply(text, config.TELEGRAM_MAX_MESSAGE_LENGTH)) {
      await ctx.reply(part, { link_preview_options: { is_disabled: true } });
    }
  } catch (error) {
    console.error('Manual chat memory refresh failed', {
      chatId: action.chatId,
      message: error instanceof Error ? error.message : String(error),
    });
    await status.fail('Не удалось обновить память чата. Попробуйте позже.');
  }
  return true;
}

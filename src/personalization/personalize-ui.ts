import { InlineKeyboard, type Api, type Context } from 'grammy';
import { config, ownerUserId } from '../config.js';
import { startStatus } from '../core/status.js';
import { splitReply } from '../summary/summary.js';
import {
  formatManualPersonalizationSummary,
  getManualPersonalizationChatBlockReason,
  isPersonalizationRunInProgress,
  listEligibleManualPersonalizationChats,
  PersonalizationBusyError,
  runManualPersonalization,
} from './personalization-scheduler.js';

export const PERSONALIZE_CALLBACK_PREFIX = 'pers:';

const PICKER_TEXT = 'Выберите группу для персонализации:';
const EMPTY_PICKER_TEXT =
  'Нет групп для персонализации (проверьте флаги и ALLOWED_CHAT_IDS).';
const CANCEL_LABEL = 'Отмена';
const CANCELLED_TEXT = 'Отменено.';
const OWNER_ONLY_ALERT = 'Только для владельца бота';
const GLOBAL_OFF_TEXT = 'Персонализация выключена глобально (PERSONALIZATION_ENABLED).';
const BUSY_TEXT = 'Персонализация уже выполняется. Попробуйте позже.';
const STARTING_STATUS = '⏳ Запускаю персонализацию…';

/** Telegram inline button text limit. */
const BUTTON_TEXT_MAX = 64;

export type PersonalizeCallbackAction =
  | { type: 'run'; chatId: number }
  | { type: 'cancel' };

/**
 * Parse `pers:` callback data. Returns null when the payload is not ours or is malformed.
 */
export function parsePersonalizeCallbackData(data: string): PersonalizeCallbackAction | null {
  if (!data.startsWith(PERSONALIZE_CALLBACK_PREFIX)) return null;
  const rest = data.slice(PERSONALIZE_CALLBACK_PREFIX.length);
  if (rest === 'cancel') return { type: 'cancel' };
  if (rest.startsWith('run:')) {
    const idStr = rest.slice(4);
    if (!/^-?\d+$/.test(idStr)) return null;
    return { type: 'run', chatId: Number(idStr) };
  }
  return null;
}

export function truncatePersonalizeButtonLabel(label: string, max = BUTTON_TEXT_MAX): string {
  if (label.length <= max) return label;
  if (max <= 1) return '…';
  return `${label.slice(0, max - 1)}…`;
}

/** One eligible group per row, then Cancel. */
export function buildPersonalizePickerKeyboard(
  chats: Array<{ chatId: number; label: string }>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    keyboard
      .text(
        truncatePersonalizeButtonLabel(chat.label),
        `${PERSONALIZE_CALLBACK_PREFIX}run:${chat.chatId}`,
      )
      .row();
  }
  keyboard.text(CANCEL_LABEL, `${PERSONALIZE_CALLBACK_PREFIX}cancel`);
  return keyboard;
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

function isPersonalizeOwner(ctx: Context): boolean {
  return Boolean(ownerUserId && ctx.from?.id === ownerUserId && !ctx.msg?.sender_chat);
}

/**
 * Shared helper: status message + `runManualPersonalization` + Russian summary replies.
 * Callers must already enforce owner / eligibility / busy gates as needed.
 */
export async function startManualPersonalizationRun(
  ctx: Context,
  api: Api,
  chatIds: number[],
): Promise<void> {
  if (isPersonalizationRunInProgress()) {
    await ctx.reply(BUSY_TEXT);
    return;
  }
  const status = await startStatus(ctx, STARTING_STATUS);
  void runManualPersonalization(api, { chatIds })
    .then(async (results) => {
      await status.clear();
      const summary = formatManualPersonalizationSummary(results);
      for (const part of splitReply(summary, config.TELEGRAM_MAX_MESSAGE_LENGTH)) {
        await ctx.reply(part, { link_preview_options: { is_disabled: true } });
      }
    })
    .catch(async (error) => {
      if (error instanceof PersonalizationBusyError) {
        await status.clear();
        await ctx.reply(BUSY_TEXT);
        return;
      }
      console.error('Manual personalization failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      await status.fail('Не удалось запустить персонализацию. Попробуйте позже.');
    });
}

/** Bare `/personalize`: list eligible groups; does not start a run. */
export async function replyWithPersonalizePicker(ctx: Context, api: Api): Promise<void> {
  const chatIds = await listEligibleManualPersonalizationChats();
  if (!chatIds.length) {
    await ctx.reply(EMPTY_PICKER_TEXT);
    return;
  }
  const chats = await Promise.all(
    chatIds.map(async (chatId) => ({
      chatId,
      label: await chatLabel(api, chatId),
    })),
  );
  await ctx.reply(PICKER_TEXT, { reply_markup: buildPersonalizePickerKeyboard(chats) });
}

/**
 * Handle `pers:` callbacks. Returns true when the update was consumed (even if rejected).
 */
export async function handlePersonalizeCallback(ctx: Context, api: Api): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(PERSONALIZE_CALLBACK_PREFIX)) return false;

  if (ctx.chat?.type !== 'private' || !isPersonalizeOwner(ctx)) {
    await ctx.answerCallbackQuery({ text: OWNER_ONLY_ALERT, show_alert: true });
    return true;
  }

  if (config.PERSONALIZATION_ENABLED !== 'true') {
    await ctx.answerCallbackQuery({ text: GLOBAL_OFF_TEXT, show_alert: true });
    return true;
  }

  const action = parsePersonalizeCallbackData(data);
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

  const blockReason = await getManualPersonalizationChatBlockReason(action.chatId);
  if (blockReason) {
    await ctx.answerCallbackQuery({ text: blockReason, show_alert: true });
    return true;
  }

  if (isPersonalizationRunInProgress()) {
    await ctx.answerCallbackQuery({ text: BUSY_TEXT, show_alert: true });
    return true;
  }

  await ctx.answerCallbackQuery();
  const label = await chatLabel(api, action.chatId);
  await ctx.editMessageText(`Выбрано: ${label}`).catch(() => {});
  await startManualPersonalizationRun(ctx, api, [action.chatId]);
  return true;
}

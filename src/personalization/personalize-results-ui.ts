import { InlineKeyboard, type Api, type Context } from 'grammy';
import { allowedChatIds, config, ownerUserId } from '../config.js';
import {
  getChatParticipant,
  listChatParticipantsWithCharacteristics,
  listChatsWithCharacteristics,
  type ChatParticipantRow,
} from '../core/db.js';
import { moscowParts } from '../core/moscow-time.js';
import { splitReply } from '../summary/summary.js';

export const PERSONALIZE_RESULTS_CALLBACK_PREFIX = 'pres:';

export const PAGE_SIZE = 10;

/**
 * Browse/results path never requires PERSONALIZATION_ENABLED (unlike `/personalize` / `pers:`).
 * Pure export for regression tests.
 */
export function personalizeResultsRequiresPersonalizationEnabled(): boolean {
  return false;
}

const CHAT_PICKER_TEXT = 'Выберите группу:';
const EMPTY_CHATS_TEXT = 'Нет групп с сохранёнными характеристиками участников.';
const EMPTY_MEMBERS_TEXT = 'В этой группе пока нет сохранённых характеристик.';
const CANCEL_LABEL = 'Отмена';
const CANCELLED_TEXT = 'Отменено.';
const BACK_TO_CHATS_LABEL = '← К группам';
const PREV_LABEL = '‹ Назад';
const NEXT_LABEL = 'Далее ›';
const OWNER_ONLY_ALERT = 'Только для владельца бота';
const NO_PROFILE_TEXT = 'У этого участника пока нет характеристики.';
const UNKNOWN_MEMBER_TEXT = 'Участник не найден.';
const OWNER_UNSET_TEXT = 'Задайте OWNER_USER_ID в .env и перезапустите бота.';

/** Telegram inline button text limit. */
const BUTTON_TEXT_MAX = 64;

export type PersonalizeResultsCallbackAction =
  | { type: 'cancel' }
  | { type: 'chats'; page: number }
  | { type: 'chat'; chatId: number; page: number }
  | { type: 'user'; chatId: number; userId: number };

/**
 * Parse `pres:` callback data. Returns null when the payload is not ours or is malformed.
 */
export function parsePersonalizeResultsCallbackData(
  data: string,
): PersonalizeResultsCallbackAction | null {
  if (!data.startsWith(PERSONALIZE_RESULTS_CALLBACK_PREFIX)) return null;
  const rest = data.slice(PERSONALIZE_RESULTS_CALLBACK_PREFIX.length);
  if (rest === 'cancel') return { type: 'cancel' };
  if (rest === 'chats') return { type: 'chats', page: 0 };
  {
    const m = /^chats:(\d+)$/.exec(rest);
    if (m) return { type: 'chats', page: Number(m[1]) };
  }
  {
    const m = /^chat:(-?\d+)(?::(\d+))?$/.exec(rest);
    if (m) {
      return {
        type: 'chat',
        chatId: Number(m[1]),
        page: m[2] !== undefined ? Number(m[2]) : 0,
      };
    }
  }
  {
    const m = /^user:(-?\d+):(\d+)$/.exec(rest);
    if (m) return { type: 'user', chatId: Number(m[1]), userId: Number(m[2]) };
  }
  return null;
}

export function truncatePersonalizeResultsButtonLabel(
  label: string,
  max = BUTTON_TEXT_MAX,
): string {
  if (label.length <= max) return label;
  if (max <= 1) return '…';
  return `${label.slice(0, max - 1)}…`;
}

export function paginateItems<T>(items: T[], page: number, pageSize = PAGE_SIZE): {
  page: number;
  totalPages: number;
  slice: T[];
} {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * pageSize;
  return {
    page: safePage,
    totalPages,
    slice: items.slice(start, start + pageSize),
  };
}

export function buildChatPickerKeyboard(
  chats: Array<{ chatId: number; label: string }>,
  page = 0,
): InlineKeyboard {
  const { page: safePage, totalPages, slice } = paginateItems(chats, page);
  const keyboard = new InlineKeyboard();
  for (const chat of slice) {
    keyboard
      .text(
        truncatePersonalizeResultsButtonLabel(chat.label),
        `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}chat:${chat.chatId}`,
      )
      .row();
  }
  if (totalPages > 1) {
    if (safePage > 0) {
      keyboard.text(
        PREV_LABEL,
        `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}chats:${safePage - 1}`,
      );
    }
    if (safePage < totalPages - 1) {
      keyboard.text(
        NEXT_LABEL,
        `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}chats:${safePage + 1}`,
      );
    }
    keyboard.row();
  }
  keyboard.text(CANCEL_LABEL, `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}cancel`);
  return keyboard;
}

export function buildMemberPickerKeyboard(
  chatId: number,
  members: Array<{ userId: number; label: string }>,
  page = 0,
): InlineKeyboard {
  const { page: safePage, totalPages, slice } = paginateItems(members, page);
  const keyboard = new InlineKeyboard();
  for (const member of slice) {
    keyboard
      .text(
        truncatePersonalizeResultsButtonLabel(member.label),
        `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}user:${chatId}:${member.userId}`,
      )
      .row();
  }
  if (totalPages > 1) {
    if (safePage > 0) {
      keyboard.text(
        PREV_LABEL,
        `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}chat:${chatId}:${safePage - 1}`,
      );
    }
    if (safePage < totalPages - 1) {
      keyboard.text(
        NEXT_LABEL,
        `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}chat:${chatId}:${safePage + 1}`,
      );
    }
    keyboard.row();
  }
  keyboard
    .text(BACK_TO_CHATS_LABEL, `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}chats`)
    .text(CANCEL_LABEL, `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}cancel`);
  return keyboard;
}

export function formatMoscowTimestamp(date: Date | null | undefined): string {
  if (!date) return 'нет';
  const p = moscowParts(date);
  return (
    `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ` +
    `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')} МСК`
  );
}

export function formatParticipantProfile(params: {
  participant: ChatParticipantRow;
  chatLabel: string;
}): string {
  const { participant, chatLabel } = params;
  const username = participant.username ? `@${participant.username}` : 'нет';
  const characteristic = (participant.characteristic ?? '').trim();
  return [
    'Характеристика участника',
    `Имя: ${participant.displayName}`,
    `Username: ${username}`,
    `user_id: ${participant.userId}`,
    `Чат: ${chatLabel}`,
    `Обновлено: ${formatMoscowTimestamp(participant.characteristicUpdatedAt)}`,
    `Источник до: ${formatMoscowTimestamp(participant.characteristicSourceUntil)}`,
    '',
    characteristic,
  ].join('\n');
}

export function memberPickerText(chatLabel: string): string {
  return `Группа: ${chatLabel}\nВыберите участника:`;
}

export function formatAllowlistDenied(chatId: number): string {
  return `Чат ${chatId} не входит в ALLOWED_CHAT_IDS.`;
}

/** Profile nav: back to this chat's member picker (page 0), plus Cancel. */
export function buildProfileNavKeyboard(chatId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(PREV_LABEL, `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}chat:${chatId}`)
    .text(CANCEL_LABEL, `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}cancel`);
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

function memberButtonLabel(participant: ChatParticipantRow): string {
  const base = participant.displayName.trim() || String(participant.userId);
  if (participant.username) {
    return truncatePersonalizeResultsButtonLabel(`${base} (@${participant.username})`);
  }
  return truncatePersonalizeResultsButtonLabel(base);
}

function isResultsOwner(ctx: Context): boolean {
  return Boolean(ownerUserId && ctx.from?.id === ownerUserId && !ctx.msg?.sender_chat);
}

async function editOrReply(ctx: Context, text: string, replyMarkup?: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageText(text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
  } catch {
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(text, replyMarkup ? { reply_markup: replyMarkup } : undefined).catch(() => {});
  }
}

async function showChatPicker(ctx: Context, api: Api, page: number, edit: boolean): Promise<void> {
  const chatIds = await listChatsWithCharacteristics();
  if (!chatIds.length) {
    if (edit) await editOrReply(ctx, EMPTY_CHATS_TEXT);
    else await ctx.reply(EMPTY_CHATS_TEXT);
    return;
  }
  const chats = await Promise.all(
    chatIds.map(async (chatId) => ({
      chatId,
      label: await chatLabel(api, chatId),
    })),
  );
  const keyboard = buildChatPickerKeyboard(chats, page);
  if (edit) await editOrReply(ctx, CHAT_PICKER_TEXT, keyboard);
  else await ctx.reply(CHAT_PICKER_TEXT, { reply_markup: keyboard });
}

async function showMemberPicker(
  ctx: Context,
  api: Api,
  chatId: number,
  page: number,
): Promise<void> {
  if (allowedChatIds.size && !allowedChatIds.has(String(chatId))) {
    await ctx.answerCallbackQuery({ text: formatAllowlistDenied(chatId), show_alert: true });
    return;
  }
  const members = await listChatParticipantsWithCharacteristics(chatId);
  const label = await chatLabel(api, chatId);
  if (!members.length) {
    await ctx.answerCallbackQuery();
    await editOrReply(
      ctx,
      EMPTY_MEMBERS_TEXT,
      new InlineKeyboard()
        .text(BACK_TO_CHATS_LABEL, `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}chats`)
        .text(CANCEL_LABEL, `${PERSONALIZE_RESULTS_CALLBACK_PREFIX}cancel`),
    );
    return;
  }
  await ctx.answerCallbackQuery();
  const keyboard = buildMemberPickerKeyboard(
    chatId,
    members.map((m) => ({ userId: m.userId, label: memberButtonLabel(m) })),
    page,
  );
  await editOrReply(ctx, memberPickerText(label), keyboard);
}

async function showUserProfile(
  ctx: Context,
  api: Api,
  chatId: number,
  userId: number,
): Promise<void> {
  if (allowedChatIds.size && !allowedChatIds.has(String(chatId))) {
    await ctx.answerCallbackQuery({ text: formatAllowlistDenied(chatId), show_alert: true });
    return;
  }
  const participant = await getChatParticipant(chatId, userId);
  if (!participant) {
    await ctx.answerCallbackQuery({ text: UNKNOWN_MEMBER_TEXT, show_alert: true });
    return;
  }
  const characteristic = (participant.characteristic ?? '').trim();
  if (!characteristic) {
    await ctx.answerCallbackQuery({ text: NO_PROFILE_TEXT, show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const label = await chatLabel(api, chatId);
  const profile = formatParticipantProfile({ participant, chatLabel: label });
  const parts = splitReply(profile, config.TELEGRAM_MAX_MESSAGE_LENGTH);
  const backKeyboard = buildProfileNavKeyboard(chatId);
  const previewOff = { link_preview_options: { is_disabled: true as const } };
  // Always attach nav on the first chunk so the owner is never stuck without buttons.
  // When split across messages, also put nav on the last chunk.
  try {
    await ctx.editMessageText(parts[0]!, {
      reply_markup: backKeyboard,
      ...previewOff,
    });
  } catch {
    await ctx
      .reply(parts[0]!, {
        reply_markup: backKeyboard,
        ...previewOff,
      })
      .catch(() => {});
  }
  for (let i = 1; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1;
    await ctx.reply(parts[i]!, {
      ...(isLast ? { reply_markup: backKeyboard } : {}),
      ...previewOff,
    });
  }
}

/** Owner DM entry: chat picker (does not start personalization jobs). */
export async function replyWithPersonalizeResultsPicker(
  ctx: Context,
  api: Api,
): Promise<void> {
  await showChatPicker(ctx, api, 0, false);
}

/**
 * Handle `pres:` callbacks. Returns true when the update was consumed (even if rejected).
 * Does not check PERSONALIZATION_ENABLED — viewing stored characteristics is always allowed for the owner.
 */
export async function handlePersonalizeResultsCallback(
  ctx: Context,
  api: Api,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(PERSONALIZE_RESULTS_CALLBACK_PREFIX)) return false;

  if (ctx.chat?.type !== 'private' || !isResultsOwner(ctx)) {
    await ctx.answerCallbackQuery({ text: OWNER_ONLY_ALERT, show_alert: true });
    return true;
  }

  const action = parsePersonalizeResultsCallbackData(data);
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

  if (action.type === 'chats') {
    await ctx.answerCallbackQuery();
    await showChatPicker(ctx, api, action.page, true);
    return true;
  }

  if (action.type === 'chat') {
    await showMemberPicker(ctx, api, action.chatId, action.page);
    return true;
  }

  await showUserProfile(ctx, api, action.chatId, action.userId);
  return true;
}

export {
  CANCELLED_TEXT,
  CHAT_PICKER_TEXT,
  EMPTY_CHATS_TEXT,
  EMPTY_MEMBERS_TEXT,
  NO_PROFILE_TEXT,
  OWNER_ONLY_ALERT,
  OWNER_UNSET_TEXT,
  UNKNOWN_MEMBER_TEXT,
};

import type { Context } from 'grammy';
import { config } from '../config.js';
import { getChatParticipant, type ChatParticipantRow } from '../core/db.js';
import { splitReply } from '../summary/summary.js';
import { formatMoscowTimestamp } from './personalize-results-ui.js';

const PRIVATE_TEXT = 'Команда /me работает только в группе. Отправьте её в чате.';
const ANONYMOUS_TEXT = 'Отправьте /me со своего аккаунта.';
const EMPTY_TEXT =
  'Пока нет характеристики. Она появляется после ежедневной персонализации в небольших чатах, когда персонализация включена.';

/**
 * Participant-facing profile formatter.
 * Omits username / user_id / chat label / «Источник до» (unlike owner formatParticipantProfile).
 */
export function formatMeProfile(participant: ChatParticipantRow): string {
  const characteristic = (participant.characteristic ?? '').trim();
  return [
    'Твоя характеристика в этом чате',
    `Обновлено: ${formatMoscowTimestamp(participant.characteristicUpdatedAt)}`,
    '',
    characteristic,
  ].join('\n');
}

/** True when characteristic text is missing or whitespace-only. */
export function isEmptyCharacteristic(characteristic: string | null | undefined): boolean {
  return !(characteristic ?? '').trim();
}

/**
 * Pure gate for /me. Returns a Russian denial message, or null when the command may proceed.
 * Does not check PERSONALIZATION_ENABLED, per-chat flags, or member count.
 */
export function meCommandDeniedReason(ctx: Context): string | null {
  const chatType = ctx.chat?.type;
  if (chatType === 'private') return PRIVATE_TEXT;
  if (!chatType || !['group', 'supergroup'].includes(chatType)) {
    return PRIVATE_TEXT;
  }
  if (!ctx.from || ctx.msg?.sender_chat) return ANONYMOUS_TEXT;
  return null;
}

export async function handleMeCommand(ctx: Context): Promise<void> {
  const denied = meCommandDeniedReason(ctx);
  if (denied) {
    await ctx.reply(denied);
    return;
  }

  const chatId = ctx.chat!.id;
  const userId = ctx.from!.id;
  const participant = await getChatParticipant(chatId, userId);

  if (!participant || isEmptyCharacteristic(participant.characteristic)) {
    await ctx.reply(EMPTY_TEXT, { link_preview_options: { is_disabled: true } });
    return;
  }

  const profile = formatMeProfile(participant);
  const previewOff = { link_preview_options: { is_disabled: true as const } };
  for (const part of splitReply(profile, config.TELEGRAM_MAX_MESSAGE_LENGTH)) {
    await ctx.reply(part, previewOff);
  }
}

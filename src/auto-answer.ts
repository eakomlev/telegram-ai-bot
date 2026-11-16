import type { Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import { resolveChatSettings } from './chat-settings.js';
import { config } from './config.js';
import {
  cancelPendingAutoAnswersForScope,
  enqueuePendingAutoAnswer,
} from './db.js';
import { parseGalleryLink } from './gallery-utils.js';
import { messageMentionsBot } from './mention.js';
import { parseVideoLink } from './video-utils.js';

/** Strong ask-the-group verbs / pronouns — mid-sentence is fine. */
const STRONG_INTERROGATIVE_RE =
  /(?:^|[^\p{L}\p{N}])(?:кто|кого|кому|кем|где|куда|откуда|когда|почему|зачем|сколько|подскажите|подскажи|подскажете|посоветуйте|посоветуй|помогите|помоги|не\s+подскажете|есть\s+ли|who|what|where|when|why|how|which|anyone|does\s+anyone|is\s+there)(?=[^\p{L}\p{N}]|$)/iu;

/** Weaker words only count near the start (avoids «как обычно», «так как»). */
const LEADING_INTERROGATIVE_RE =
  /^(?:(?:ну|эй|ребята|коллеги|народ|guys|pls|please)[,!\s]+)?(?:что|чего|чему|чем|чём|как|какой|какая|какое|какие|каким|какими|какого|какую|каких|каков|какова|каково|каковы|можно|нужно|скажите|скажи)\b/iu;

const LI_PARTICLE_RE = /(?:^|[^\p{L}\p{N}])[\p{L}]{2,}(?:\s+|\s*[,–—-]\s*)ли(?=[^\p{L}\p{N}]|$)/iu;

const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s\uFE0F\u200D]+$/u;

/** Short reaction chatter that often ends with ? but is not a real group question. */
const SHORT_CHATTER_RE =
  /^(ок|окей|да|нет|ну|ага|угу|лол|кек|хех|хм|эм|серь[её]зно|правда|точно|реально|why|what|lol|yep|nah|wow|yes|no|huh)$/iu;

function entitiesOf(message: Message): MessageEntity[] {
  return message.entities ?? message.caption_entities ?? [];
}

function authorOf(message: Message): string {
  if (message.sender_chat?.title) return message.sender_chat.title;
  const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ');
  return name || message.from?.username || 'Участник';
}

function lettersOnly(value: string) {
  return value.replace(/[^\p{L}\p{N}]+/gu, '');
}

function hasInterrogativeCue(value: string) {
  return STRONG_INTERROGATIVE_RE.test(value)
    || LEADING_INTERROGATIVE_RE.test(value)
    || LI_PARTICLE_RE.test(value);
}

/** True when the text looks like a general question to the group (precision over recall). */
export function isGeneralQuestion(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (EMOJI_ONLY_RE.test(value)) return false;

  const letters = lettersOnly(value);
  const letterCount = Array.from(letters).length;
  if (letterCount < 2) return false;
  if (SHORT_CHATTER_RE.test(letters)) return false;

  const hasQuestionMark = /[?？]/.test(value);
  if (hasQuestionMark) {
    if (letterCount >= 6) return true;
    // Very short with ?: only if there is a clear interrogative cue («Кто?»).
    return hasInterrogativeCue(value);
  }

  if (hasInterrogativeCue(value)) return true;

  // Avoid enrolling very short non-interrogative chatter.
  if (Array.from(value).length < 12) return false;
  return false;
}

export function messageHasAnyMention(message: Message): boolean {
  for (const entity of entitiesOf(message)) {
    if (entity.type === 'mention' || entity.type === 'text_mention') return true;
  }
  return false;
}

export function isUrlOnlyMediaCandidate(text: string, entities: MessageEntity[] = []): boolean {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return Boolean(parseVideoLink(trimmed) || parseGalleryLink(trimmed, entities));
}

export function shouldEnqueueAutoAnswer(message: Message): boolean {
  if (message.from?.is_bot && !message.sender_chat) return false;
  const text = (message.text ?? message.caption ?? '').trim();
  if (!text) return false;
  if (/^\/[\w]+(?:@\w+)?(?:\s|$)/.test(text)) return false;
  if (message.reply_to_message) return false;
  if (messageMentionsBot(message)) return false;
  if (messageHasAnyMention(message)) return false;
  if (isUrlOnlyMediaCandidate(text, entitiesOf(message))) return false;
  return isGeneralQuestion(text);
}

function isForumChat(ctx: Context): boolean {
  const chat = ctx.chat;
  return Boolean(chat && 'is_forum' in chat && chat.is_forum);
}

/** Pure cancel predicate used by DB scope updates and unit tests. */
export function activityCancelsPending(
  pending: { messageId: number; messageThreadId: number | null },
  activity: {
    replyToMessageId?: number;
    messageThreadId?: number | null;
    isForum: boolean;
  },
): boolean {
  if (activity.replyToMessageId != null && activity.replyToMessageId === pending.messageId) {
    return true;
  }
  if (activity.isForum) {
    return (activity.messageThreadId ?? null) === (pending.messageThreadId ?? null);
  }
  return true;
}

/** Cancel pending auto-answers engaged by this human message (reply or same topic/chat). */
export async function cancelPendingAutoAnswersForActivity(ctx: Context) {
  const message = ctx.message;
  if (!message || !ctx.chat) return;
  if (message.from?.is_bot && !message.sender_chat) return;

  await cancelPendingAutoAnswersForScope({
    chatId: ctx.chat.id,
    replyToMessageId: message.reply_to_message?.message_id,
    messageThreadId: message.message_thread_id ?? null,
    isForum: isForumChat(ctx),
  });
}

export async function maybeEnqueueAutoAnswer(ctx: Context) {
  if (config.AUTO_ANSWER_ENABLED !== 'true') return;
  if (!ctx.message || !ctx.chat) return;
  if (!shouldEnqueueAutoAnswer(ctx.message)) return;

  const settings = await resolveChatSettings(ctx.chat.id);
  if (!settings.autoAnswerEnabled) return;

  const text = (ctx.message.text ?? ctx.message.caption ?? '').trim();
  const capped = text.length > config.AUTO_ANSWER_MAX_INPUT_CHARS
    ? `${text.slice(0, config.AUTO_ANSWER_MAX_INPUT_CHARS)}…`
    : text;
  const createdAt = new Date(ctx.message.date * 1000);
  const dueAt = new Date(createdAt.getTime() + config.AUTO_ANSWER_DELAY_SECONDS * 1000);

  await enqueuePendingAutoAnswer({
    chatId: ctx.chat.id,
    messageId: ctx.message.message_id,
    messageThreadId: ctx.message.message_thread_id ?? null,
    author: authorOf(ctx.message),
    questionText: capped,
    askerUserId: ctx.message.from?.id ?? null,
    createdAt,
    dueAt,
  }).catch((error) => {
    console.error('Enqueue auto-answer failed', {
      chatId: ctx.chat?.id,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

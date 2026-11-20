import { InputFile, type Api, type Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import {
  mentionShouldUseWebSearchPath,
  replyToMention,
  type MentionInputImage,
} from '../ai/ai.js';
import {
  formatContextLine,
  prepareMentionContextBlocks,
  trimPrecedingContext,
  type ContextLine,
} from '../chat/chat-context.js';
import { formatChatMemoryBlock } from '../chat/chat-memory.js';
import { resolveChatSettings } from '../chat/chat-settings.js';
import { config } from '../config.js';
import {
  getChatMemory,
  persistBotMessage,
  recordOpenAiUsage,
  selectPrecedingMessages,
  selectReplyChain,
} from '../core/db.js';
import { splitReply, splitCaptionReply, truncateText } from '../summary/summary.js';
import { enqueueAi } from '../core/ai-jobs.js';
import { startStatus } from '../core/status.js';

let botIdentity: { id: number; username: string } | undefined;
const recentMentions = new Map<number, number>();

export function setBotIdentity(id: number, username: string) {
  botIdentity = { id, username: username.toLowerCase() };
}

export function getBotUsername() {
  return botIdentity?.username;
}

/** Display label for persisted outbound bot replies (`@username`). */
export function getBotAuthorLabel() {
  return botIdentity?.username ? `@${botIdentity.username}` : 'Бот';
}

async function persistSentBotReply(
  chatId: number,
  sent: Message | undefined,
  replyToMessageId?: number | null,
) {
  if (!sent) return;
  await persistBotMessage(chatId, sent, getBotAuthorLabel(), replyToMessageId).catch(() => {
    console.error('Bot message persist failed', { chatId, messageId: sent.message_id });
  });
}

function entitiesOf(message: Message): MessageEntity[] {
  return message.entities ?? message.caption_entities ?? [];
}

export function messageMentionsBot(message: Message, identity = botIdentity): boolean {
  if (!identity) return false;
  const text = message.text ?? message.caption;
  if (!text) return false;
  for (const entity of entitiesOf(message)) {
    if (entity.type === 'mention') {
      const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
      if (mention === `@${identity.username}`) return true;
    }
    if (entity.type === 'text_mention' && entity.user?.id === identity.id) return true;
  }
  return false;
}

/** True when the user replies to one of the bot's own messages (quote/reply). */
export function messageRepliesToBot(message: Message, identity = botIdentity): boolean {
  if (!identity) return false;
  const reply = message.reply_to_message;
  if (!reply?.from) return false;
  return reply.from.id === identity.id;
}

/** @mention of the bot or a reply to the bot's message. */
export function messageAddressesBot(message: Message, identity = botIdentity): boolean {
  return messageMentionsBot(message, identity) || messageRepliesToBot(message, identity);
}

/** Remove @bot mentions so the model sees the actual request. */
export function stripBotMention(text: string, username: string, entities: MessageEntity[] = []): string {
  const ranges = entities
    .filter((entity) => {
      if (entity.type === 'mention') {
        return text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username.toLowerCase()}`;
      }
      return false;
    })
    .map((entity) => [entity.offset, entity.offset + entity.length] as const)
    .sort((a, b) => b[0] - a[0]);

  let cleaned = text;
  for (const [start, end] of ranges) cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  cleaned = cleaned.replace(new RegExp(`@${username}\\b`, 'gi'), ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
}

function authorOf(message: Message): string {
  if (message.sender_chat?.title) return message.sender_chat.title;
  const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ');
  return name || message.from?.username || 'Участник';
}

/** Largest Telegram photo or an image document from a message. */
export function collectMessageImageFileIds(message: Message | undefined): string[] {
  if (!message) return [];
  const ids: string[] = [];
  if (message.photo?.length) ids.push(message.photo[message.photo.length - 1]!.file_id);
  const mime = message.document?.mime_type ?? '';
  if (message.document?.file_id && /^image\/(jpeg|png|webp|gif)$/i.test(mime)) {
    ids.push(message.document.file_id);
  }
  return ids;
}

export function quotedContext(message: Message | undefined): { author: string; text: string } | undefined {
  if (!message) return;
  const text = (message.text ?? message.caption ?? '').trim();
  const hasImage = collectMessageImageFileIds(message).length > 0;
  if (!text && !hasImage) return;
  return { author: authorOf(message), text: text || '(изображение без подписи)' };
}

/** Detect meme intent by keywords in the user request (not the quote body alone). */
export function isMemeRequest(text: string): boolean {
  const value = text.trim().toLowerCase();
  if (!value) return false;
  if (/(?:^|[^\p{L}\p{N}])мем(?:ы|а|у|ом|е|ов|ами|ах)?(?=[^\p{L}\p{N}]|$)/u.test(value)) return true;
  if (/\bmemes?\b/.test(value)) return true;
  if (/демотиватор/.test(value)) return true;
  if (/\bdrake\b/.test(value)) return true;
  if (/\bwojak\b|войак/.test(value)) return true;
  if (/\bpepe\b|пепе/.test(value)) return true;
  if (/две\s+кнопк/.test(value)) return true;
  if (/two\s+buttons/.test(value)) return true;
  if (/expanding\s+brain/.test(value)) return true;
  if (/distracted\s+boyfriend/.test(value)) return true;
  return false;
}

/** Clear non-meme image-generation intent → keep Chat Completions + attach_image. */
export function isImageGenerationRequest(text: string): boolean {
  const value = text.trim().toLowerCase();
  if (!value) return false;
  // Cyrillic: \b is ASCII-only in JS — use Unicode letter/number boundaries.
  const ruBound = (word: string) =>
    new RegExp(`(?:^|[^\\p{L}\\p{N}])${word}(?=[^\\p{L}\\p{N}]|$)`, 'u');
  if (ruBound('нарисуй(?:те)?').test(value) || ruBound('нарисовать').test(value)) return true;
  // "сгенерируй/сделай/создай картинку|изображение" (stem match avoids ending noise).
  if (/(?:сгенерируй(?:те)?|сделай(?:те)?|создай(?:те)?)\s+(?:картинк|изображен)/u.test(value)) return true;
  if (/\bgenerate\s+(?:an?\s+)?images?\b/.test(value)) return true;
  if (/\bcreate\s+(?:an?\s+)?images?\b/.test(value)) return true;
  if (/\bdraw\s+(?:me|us|a|an)\b/.test(value)) return true;
  return false;
}

export type MentionPromptBudgets = {
  requestMaxChars: number;
  quoteMaxChars: number;
  recentMaxChars: number;
  aroundQuoteMaxChars: number;
  threadMaxChars: number;
};

export function mentionPromptBudgetsFromConfig(): MentionPromptBudgets {
  return {
    requestMaxChars: config.MENTION_MAX_INPUT_CHARS,
    quoteMaxChars: config.MENTION_QUOTE_MAX_CHARS,
    recentMaxChars: config.MENTION_CONTEXT_MAX_CHARS,
    aroundQuoteMaxChars: config.MENTION_AROUND_QUOTE_MAX_CHARS,
    threadMaxChars: config.MENTION_THREAD_MAX_CHARS,
  };
}

function formatMentionContextBlock(header: string, messages: ContextLine[], maxChars: number): string {
  const trimmed = trimPrecedingContext(messages, maxChars);
  const lines = trimmed
    .map(formatContextLine)
    .filter((line) => !/^\[.+\]:\s*$/.test(line));
  if (!lines.length) return '';
  return `${header}\n${lines.join('\n')}`;
}

/**
 * Request and quote are truncated on their own budgets. Context blocks never shrink them.
 * With no quote and no context blocks, the request is returned without a header.
 */
export function buildMentionPrompt(
  userText: string,
  quoted: { author: string; text: string } | undefined,
  budgets: MentionPromptBudgets,
  hasImages = false,
  blocks: { recent?: ContextLine[]; aroundQuote?: ContextLine[]; thread?: ContextLine[] } = {},
): string {
  const requestRaw = userText.trim()
    || (quoted || hasImages ? 'Опиши и прокомментируй по делу с учётом контекста и изображений.' : '');
  const request = requestRaw ? truncateText(requestRaw, budgets.requestMaxChars) : '';

  const recentBlock = formatMentionContextBlock(
    'Контекст (недавние сообщения):',
    blocks.recent ?? [],
    budgets.recentMaxChars,
  );
  const aroundBlock = formatMentionContextBlock(
    'Контекст (рядом с цитатой):',
    blocks.aroundQuote ?? [],
    budgets.aroundQuoteMaxChars,
  );
  const threadBlock = formatMentionContextBlock(
    'Ветка обсуждения:',
    blocks.thread ?? [],
    budgets.threadMaxChars,
  );

  const contextSections = [recentBlock, aroundBlock, threadBlock].filter(Boolean);
  if (!quoted && contextSections.length === 0) return request;

  const sections = [...contextSections];
  if (quoted) {
    const author = (quoted.author || 'Участник').replace(/\s+/g, ' ').trim() || 'Участник';
    const quoteText = truncateText(quoted.text.trim(), budgets.quoteMaxChars);
    if (quoteText) sections.push(`Цитата (${author}):\n${quoteText}`);
  }
  if (request) sections.push(`Запрос:\n${request}`);
  return sections.join('\n\n');
}

function toContextLines(rows: { message_id: number; author: string; text: string }[]): ContextLine[] {
  return rows.map((row) => ({ author: row.author, text: row.text, messageId: row.message_id }));
}

function claimMentionSlot(chatId: number) {
  const now = Date.now();
  const cooldown = config.MENTION_COOLDOWN_SECONDS * 1000;
  for (const [id, time] of recentMentions) if (now - time >= cooldown) recentMentions.delete(id);
  if (recentMentions.has(chatId)) return false;
  recentMentions.set(chatId, now);
  return true;
}

function mimeFromPath(path: string | undefined, fallback = 'image/jpeg') {
  const lower = (path ?? '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return fallback;
}

async function downloadTelegramImages(api: Api, fileIds: string[]): Promise<MentionInputImage[]> {
  if (config.MENTION_VISION_ENABLED !== 'true' || config.MENTION_MAX_INPUT_IMAGES <= 0) return [];
  const maxBytes = config.MENTION_MAX_INPUT_IMAGE_MB * 1024 * 1024;
  const unique = [...new Set(fileIds)].slice(0, config.MENTION_MAX_INPUT_IMAGES);
  const images: MentionInputImage[] = [];
  for (const fileId of unique) {
    try {
      const file = await api.getFile(fileId);
      if (!file.file_path) continue;
      if (typeof file.file_size === 'number' && file.file_size > maxBytes) continue;
      const path = file.file_path.replace(/^\/+/, '');
      const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${path}`;
      const response = await fetch(url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > maxBytes) continue;
      images.push({ mime: mimeFromPath(file.file_path), data: buffer });
    } catch {
      console.error('Mention image download failed');
    }
  }
  return images;
}

export async function maybeHandleMention(ctx: Context): Promise<boolean> {
  if (config.MENTION_ENABLED !== 'true' || !ctx.message || !ctx.chat || !botIdentity) return false;
  if (!messageAddressesBot(ctx.message)) return false;

  const settings = await resolveChatSettings(ctx.chat.id);
  if (!settings.mentionEnabled) return false;

  const raw = ctx.message.text ?? ctx.message.caption ?? '';
  const userText = stripBotMention(raw, botIdentity.username, entitiesOf(ctx.message));
  const quoted = quotedContext(ctx.message.reply_to_message);
  const fileIds = [
    ...collectMessageImageFileIds(ctx.message),
    ...collectMessageImageFileIds(ctx.message.reply_to_message),
  ];

  // Cheap empty check before cooldown/DB (without preceding).
  const budgets = mentionPromptBudgetsFromConfig();
  const draftPrompt = buildMentionPrompt(userText, quoted, budgets, fileIds.length > 0);
  if (!draftPrompt && !fileIds.length) {
    await ctx.reply(
      'Напишите вопрос после упоминания бота, ответьте на моё сообщение, приложите картинку или ответьте цитатой на сообщение.',
      {
        reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
        ...(ctx.message.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
      },
    ).catch(() => {});
    return true;
  }

  if (!claimMentionSlot(ctx.chat.id)) {
    await ctx.reply(`Подождите ${config.MENTION_COOLDOWN_SECONDS} сек. между обращениями ко мне.`, {
      reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
      ...(ctx.message.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
    }).catch(() => {});
    return true;
  }

  const message = ctx.message;
  const chat = ctx.chat;
  const accepted = await enqueueAi(ctx, async () => {
    let recent: ContextLine[] = [];
    if (config.MENTION_CONTEXT_MAX_MESSAGES > 0) {
      try {
        const rows = await selectPrecedingMessages({
          chatId: chat.id,
          beforeMessageId: message.message_id,
          beforeSentAt: new Date(message.date * 1000),
          messageThreadId: message.message_thread_id ?? null,
          lookbackMinutes: config.MENTION_CONTEXT_LOOKBACK_MINUTES,
          maxMessages: config.MENTION_CONTEXT_MAX_MESSAGES,
        });
        recent = toContextLines(rows);
      } catch (error) {
        console.error('Mention context load failed', {
          chatId: chat.id,
          messageId: message.message_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let aroundQuote: ContextLine[] = [];
    let thread: ContextLine[] = [];
    const replyTo = message.reply_to_message;
    const replyChatId = replyTo?.chat?.id;
    const replyInThisChat = Boolean(replyTo) && (replyChatId == null || replyChatId === chat.id);
    if (replyTo && replyInThisChat && config.MENTION_AROUND_QUOTE_MAX_MESSAGES > 0) {
      try {
        const rows = await selectPrecedingMessages({
          chatId: chat.id,
          beforeMessageId: replyTo.message_id,
          beforeSentAt: new Date(replyTo.date * 1000),
          messageThreadId: replyTo.message_thread_id ?? null,
          lookbackMinutes: config.MENTION_AROUND_QUOTE_LOOKBACK_MINUTES,
          maxMessages: config.MENTION_AROUND_QUOTE_MAX_MESSAGES,
        });
        aroundQuote = toContextLines(rows);
      } catch (error) {
        console.error('Mention around-quote context load failed', {
          chatId: chat.id,
          messageId: replyTo.message_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (replyTo && replyInThisChat && config.MENTION_THREAD_MAX_MESSAGES > 0) {
      try {
        const rows = await selectReplyChain({
          chatId: chat.id,
          startMessageId: replyTo.message_id,
          maxMessages: config.MENTION_THREAD_MAX_MESSAGES,
        });
        thread = toContextLines(rows);
      } catch (error) {
        console.error('Mention thread load failed', {
          chatId: chat.id,
          messageId: replyTo.message_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const blocks = prepareMentionContextBlocks({
      recent,
      aroundQuote,
      thread,
      quoteMessageId: replyInThisChat ? replyTo?.message_id : undefined,
      recentMaxChars: budgets.recentMaxChars,
      aroundQuoteMaxChars: budgets.aroundQuoteMaxChars,
      threadMaxChars: budgets.threadMaxChars,
    });
    const prompt = buildMentionPrompt(userText, quoted, budgets, fileIds.length > 0, blocks);

    let memoryBlock = '';
    try {
      const memory = await getChatMemory(chat.id);
      memoryBlock = formatChatMemoryBlock({
        body: memory.body,
        pinned: memory.pinned,
        bodyMaxChars: config.CHAT_MEMORY_PROMPT_MAX_CHARS,
        pinMaxChars: config.CHAT_MEMORY_PIN_MAX_CHARS,
      });
    } catch (error) {
      console.error('Chat memory load failed', {
        chatId: chat.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const reply = {
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    };
    const memeMode = isMemeRequest(userText);
    const forceCompletions = !memeMode && isImageGenerationRequest(userText);
    const useWebSearchPath = mentionShouldUseWebSearchPath({ memeMode, forceCompletions });
    const statusText = memeMode
      ? '⏳ Делаю мем…'
      : forceCompletions
        ? '⏳ Рисую…'
        : useWebSearchPath
          ? '⏳ Думаю / ищу…'
          : '⏳ Думаю…';
    const status = await startStatus(ctx, statusText, reply);
    try {
      const inputImages = await downloadTelegramImages(ctx.api, fileIds);
      const result = await replyToMention(prompt || 'Опиши и прокомментируй изображение(я).', {
        sarcasmLevel: settings.sarcasmLevel,
        responseTone: settings.responseTone,
        imagesEnabled: config.MENTION_IMAGES_ENABLED === 'true',
        maxImages: config.MENTION_MAX_IMAGES,
        maxOutputTokens: config.MENTION_MAX_OUTPUT_TOKENS,
        inputImages,
        memeMode,
        forceCompletions,
        memoryBlock,
      });
      const chatId = chat.id;
      await recordOpenAiUsage(chatId, {
        kind: 'mention',
        model: result.usage.model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        imageCount: result.usage.imageCount,
        estimatedCostUsd: result.usage.estimatedCostUsd,
      }).catch(() => console.error('OpenAI usage record failed', { chatId, kind: 'mention' }));
      const parts = splitReply(result.text.trim() || ' ', config.TELEGRAM_MAX_MESSAGE_LENGTH);
      const mediaText = splitCaptionReply(result.text.trim(), config.TELEGRAM_MAX_CAPTION_LENGTH, config.TELEGRAM_MAX_MESSAGE_LENGTH);
      const preview = { link_preview_options: { is_disabled: true as const } };

      if (result.images.length === 1) {
        const photo = await ctx.replyWithPhoto(new InputFile(result.images[0]!, 'image.png'), {
          ...reply,
          caption: mediaText.caption,
        });
        await persistSentBotReply(chatId, photo, message.message_id);
        for (const part of mediaText.messages) {
          const sent = await ctx.reply(part, { ...reply, ...preview });
          await persistSentBotReply(chatId, sent, message.message_id);
        }
      } else if (result.images.length > 1) {
        const album = await ctx.replyWithMediaGroup(
          result.images.map((buffer, index) => ({
            type: 'photo' as const,
            media: new InputFile(buffer, `image-${index}.png`),
            ...(index === 0 ? { caption: mediaText.caption } : {}),
          })),
          reply,
        );
        await persistSentBotReply(chatId, album[0], message.message_id);
        for (const part of mediaText.messages) {
          const sent = await ctx.reply(part, { ...reply, ...preview });
          await persistSentBotReply(chatId, sent, message.message_id);
        }
      } else {
        const first = await ctx.reply(parts[0]!, { ...reply, ...preview });
        await persistSentBotReply(chatId, first, message.message_id);
        for (const part of parts.slice(1)) {
          const sent = await ctx.reply(part, { ...reply, ...preview });
          await persistSentBotReply(chatId, sent, message.message_id);
        }
      }
      await status.clear();
    } catch {
      console.error('Mention reply failed', { chatId: chat.id });
      await status.fail('Не удалось ответить. Попробуйте позже или проверьте баланс OpenAI.');
    }
  });
  if (!accepted) recentMentions.delete(chat.id);
  return true;
}

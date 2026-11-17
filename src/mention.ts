import { InputFile, type Api, type Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import { replyToMention, type MentionInputImage } from './ai.js';
import {
  formatContextLine,
  trimPrecedingContext,
  type ChatContextMessage,
} from './chat-context.js';
import { resolveChatSettings } from './chat-settings.js';
import { config } from './config.js';
import { persistBotMessage, recordOpenAiUsage, selectPrecedingMessages } from './db.js';
import { splitReply, splitCaptionReply, truncateText } from './summary.js';
import { enqueueAi } from './ai-jobs.js';
import { startStatus } from './status.js';

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

async function persistSentBotReply(chatId: number, sent: Message | undefined) {
  if (!sent) return;
  await persistBotMessage(chatId, sent, getBotAuthorLabel()).catch(() => {
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

/** Attach preceding chat lines in front of the main body; drop/truncate oldest first. */
function withPrecedingContext(
  body: string,
  preceding: ChatContextMessage[],
  maxChars: number,
  contextHeader: string,
): string {
  if (body.length > maxChars) return truncateText(body, maxChars);
  const contextLines = preceding
    .map(formatContextLine)
    .filter((line) => !/^\[.+\]:\s*$/.test(line));
  if (!contextLines.length) return body;

  const separator = '\n\n';
  const contextBudget = maxChars - contextHeader.length - separator.length - body.length;
  if (contextBudget < 1) return body;

  const selected = [...contextLines];
  const joinedLen = () => selected.join('\n').length;
  while (selected.length > 1 && joinedLen() > contextBudget) {
    selected.shift();
  }
  if (selected.length === 0) return body;

  let contextBody = selected.join('\n');
  if (contextBody.length > contextBudget) {
    const ellipsis = '…';
    const keep = Math.max(0, contextBudget - ellipsis.length);
    contextBody = `${contextBody.slice(0, keep)}${ellipsis}`;
  }
  if (!contextBody.trim()) return body;

  const result = `${contextHeader}${contextBody}${separator}${body}`;
  return result.length > maxChars ? truncateText(result, maxChars) : result;
}

/**
 * Prefer keeping the user request, then the quote; drop/truncate preceding first.
 * Empty preceding keeps the previous format unchanged.
 */
export function buildMentionPrompt(
  userText: string,
  quoted: { author: string; text: string } | undefined,
  maxChars: number,
  hasImages = false,
  preceding: ChatContextMessage[] = [],
): string {
  const request = userText.trim()
    || (quoted || hasImages ? 'Опиши и прокомментируй по делу с учётом контекста и изображений.' : '');
  if (!request) return '';

  if (!quoted) {
    const body = preceding.length ? `Запрос:\n${request}` : request;
    const capped = body.length > maxChars ? truncateText(body, maxChars) : body;
    // Barely room for a labeled request — skip preceding.
    if (preceding.length && maxChars - capped.length < 20) {
      return request.length > maxChars ? truncateText(request, maxChars) : request;
    }
    return withPrecedingContext(
      capped,
      preceding,
      maxChars,
      'Контекст (недавние сообщения):\n',
    );
  }

  const header = `Цитата (${quoted.author}):\n`;
  const footer = `\n\nЗапрос:\n${request}`;
  const budget = maxChars - header.length - footer.length;
  // Quote+request barely fit — omit preceding entirely (same compact path as before).
  if (budget < 40) {
    const requestBody = truncateText(`Запрос: ${request}`, maxChars);
    const quoteBudget = maxChars - requestBody.length - '\n\nЦитата: '.length;
    return quoteBudget > 0
      ? `Цитата: ${truncateText(quoted.text, quoteBudget)}\n\n${requestBody}`
      : requestBody;
  }
  const quote = quoted.text.length > budget ? truncateText(quoted.text, budget) : quoted.text;
  const quoteAndRequest = `${header}${quote}${footer}`;
  return withPrecedingContext(
    quoteAndRequest,
    preceding,
    maxChars,
    'Контекст (сообщения до цитаты):\n',
  );
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
  const draftPrompt = buildMentionPrompt(
    userText,
    quoted,
    config.MENTION_MAX_INPUT_CHARS,
    fileIds.length > 0,
  );
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
    let preceding: ChatContextMessage[] = [];
    if (config.MENTION_CONTEXT_MAX_MESSAGES > 0) {
      // With a quote, anchor before the quoted message; otherwise before the mention itself.
      const replyTo = quoted ? message.reply_to_message : undefined;
      const anchor = replyTo ?? message;
      try {
        const rows = await selectPrecedingMessages({
          chatId: chat.id,
          beforeMessageId: anchor.message_id,
          beforeSentAt: new Date(anchor.date * 1000),
          messageThreadId: anchor.message_thread_id ?? message.message_thread_id ?? null,
          lookbackMinutes: config.MENTION_CONTEXT_LOOKBACK_MINUTES,
          maxMessages: config.MENTION_CONTEXT_MAX_MESSAGES,
        });
        preceding = trimPrecedingContext(
          rows.map((message) => ({ author: message.author, text: message.text })),
          config.MENTION_CONTEXT_MAX_CHARS,
        );
      } catch (error) {
        console.error('Mention context load failed', {
          chatId: chat.id,
          messageId: anchor.message_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const prompt = buildMentionPrompt(
      userText,
      quoted,
      config.MENTION_MAX_INPUT_CHARS,
      fileIds.length > 0,
      preceding,
    );

    const reply = {
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    };
    const memeMode = isMemeRequest(userText);
    const status = await startStatus(ctx, memeMode ? '⏳ Делаю мем…' : '⏳ Думаю…', reply);
    try {
      const inputImages = await downloadTelegramImages(ctx.api, fileIds);
      const result = await replyToMention(prompt || 'Опиши и прокомментируй изображение(я).', {
        sarcasmLevel: settings.sarcasmLevel,
        imagesEnabled: config.MENTION_IMAGES_ENABLED === 'true',
        maxImages: config.MENTION_MAX_IMAGES,
        maxOutputTokens: config.MENTION_MAX_OUTPUT_TOKENS,
        inputImages,
        memeMode,
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
        await persistSentBotReply(chatId, photo);
        for (const part of mediaText.messages) {
          const sent = await ctx.reply(part, { ...reply, ...preview });
          await persistSentBotReply(chatId, sent);
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
        await persistSentBotReply(chatId, album[0]);
        for (const part of mediaText.messages) {
          const sent = await ctx.reply(part, { ...reply, ...preview });
          await persistSentBotReply(chatId, sent);
        }
      } else {
        const first = await ctx.reply(parts[0]!, { ...reply, ...preview });
        await persistSentBotReply(chatId, first);
        for (const part of parts.slice(1)) {
          const sent = await ctx.reply(part, { ...reply, ...preview });
          await persistSentBotReply(chatId, sent);
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

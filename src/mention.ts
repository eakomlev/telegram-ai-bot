import { InputFile, type Api, type Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import { replyToMention, type MentionInputImage } from './ai.js';
import { resolveChatSettings } from './chat-settings.js';
import { config } from './config.js';
import { recordOpenAiUsage } from './db.js';
import { splitReply } from './summary.js';
import { startStatus } from './status.js';

let botIdentity: { id: number; username: string } | undefined;
const recentMentions = new Map<number, number>();

export function setBotIdentity(id: number, username: string) {
  botIdentity = { id, username: username.toLowerCase() };
}

export function getBotUsername() {
  return botIdentity?.username;
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

/** Prefer keeping the user request; trim the quote first if over budget. */
export function buildMentionPrompt(
  userText: string,
  quoted: { author: string; text: string } | undefined,
  maxChars: number,
  hasImages = false,
): string {
  const request = userText.trim()
    || (quoted || hasImages ? 'Опиши и прокомментируй по делу с учётом контекста и изображений.' : '');
  if (!request) return '';
  if (!quoted) return request.length > maxChars ? `${request.slice(0, maxChars)}…` : request;

  const header = `Цитата (${quoted.author}):\n`;
  const footer = `\n\nЗапрос:\n${request}`;
  const budget = maxChars - header.length - footer.length;
  if (budget < 40) {
    const compact = `Цитата: ${quoted.text}\n\nЗапрос: ${request}`;
    return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
  }
  const quote = quoted.text.length > budget ? `${quoted.text.slice(0, budget)}…` : quoted.text;
  return `${header}${quote}${footer}`;
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
  if (!messageMentionsBot(ctx.message)) return false;

  const settings = await resolveChatSettings(ctx.chat.id);
  if (!settings.mentionEnabled) return false;

  const raw = ctx.message.text ?? ctx.message.caption ?? '';
  const userText = stripBotMention(raw, botIdentity.username, entitiesOf(ctx.message));
  const quoted = quotedContext(ctx.message.reply_to_message);
  const fileIds = [
    ...collectMessageImageFileIds(ctx.message),
    ...collectMessageImageFileIds(ctx.message.reply_to_message),
  ];
  const prompt = buildMentionPrompt(
    userText,
    quoted,
    config.MENTION_MAX_INPUT_CHARS,
    fileIds.length > 0,
  );
  if (!prompt && !fileIds.length) {
    await ctx.reply('Напишите вопрос после упоминания бота, приложите картинку или ответьте цитатой на сообщение.', {
      reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
      ...(ctx.message.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
    }).catch(() => {});
    return true;
  }

  if (!claimMentionSlot(ctx.chat.id)) {
    await ctx.reply(`Подождите ${config.MENTION_COOLDOWN_SECONDS} сек. между обращениями ко мне.`, {
      reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
      ...(ctx.message.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
    }).catch(() => {});
    return true;
  }

  const reply = {
    reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
    ...(ctx.message.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
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
    const chatId = ctx.chat.id;
    await recordOpenAiUsage(chatId, {
      kind: 'mention',
      model: result.usage.model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      imageCount: result.usage.imageCount,
      estimatedCostUsd: result.usage.estimatedCostUsd,
    }).catch(() => console.error('OpenAI usage record failed', { chatId, kind: 'mention' }));
    const parts = splitReply(result.text.trim() || ' ', config.TELEGRAM_MAX_MESSAGE_LENGTH);
    const preview = { link_preview_options: { is_disabled: true as const } };

    if (result.images.length === 1) {
      await ctx.replyWithPhoto(new InputFile(result.images[0]!, 'image.png'), {
        ...reply,
        caption: parts[0]!.slice(0, config.TELEGRAM_MAX_CAPTION_LENGTH),
      });
      for (const part of parts.slice(1)) await ctx.reply(part, { ...reply, ...preview });
    } else if (result.images.length > 1) {
      await ctx.replyWithMediaGroup(
        result.images.map((buffer, index) => ({
          type: 'photo' as const,
          media: new InputFile(buffer, `image-${index}.png`),
          ...(index === 0 ? { caption: parts[0]!.slice(0, config.TELEGRAM_MAX_CAPTION_LENGTH) } : {}),
        })),
        reply,
      );
      for (const part of parts.slice(1)) await ctx.reply(part, { ...reply, ...preview });
    } else {
      await ctx.reply(parts[0]!, { ...reply, ...preview });
      for (const part of parts.slice(1)) await ctx.reply(part, { ...reply, ...preview });
    }
    await status.clear();
  } catch {
    console.error('Mention reply failed', { chatId: ctx.chat.id });
    await status.fail('Не удалось ответить. Попробуйте позже или проверьте баланс OpenAI.');
  }
  return true;
}

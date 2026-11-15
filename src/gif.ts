import type { Context } from 'grammy';
import { suggestGifReaction } from './ai.js';
import { resolveChatSettings } from './chat-settings.js';
import { config } from './config.js';
import { pool, recordOpenAiUsage, selectMessages } from './db.js';
import { parseSelection, prepareMessages } from './summary.js';
import { pickRandomUrl, searchGiphyAnimations } from './giphy.js';

const recentGif = new Map<number, number>();

function claimGifSlot(chatId: number) {
  const now = Date.now();
  const cooldown = config.GIF_COOLDOWN_SECONDS * 1000;
  for (const [id, time] of recentGif) if (now - time >= cooldown) recentGif.delete(id);
  if (recentGif.has(chatId)) return false;
  recentGif.set(chatId, now);
  return true;
}

export async function runGifReaction(ctx: Context) {
  if (config.GIF_ENABLED !== 'true') {
    await ctx.reply('Команда /gif сейчас выключена.');
    return;
  }
  if (!config.GIPHY_API_KEY.trim()) {
    await ctx.reply('Для /gif нужен GIPHY_API_KEY в настройках бота (ключ на developers.giphy.com).');
    return;
  }

  const chatId = ctx.chat!.id;
  const settings = await resolveChatSettings(chatId);
  const defaultCount = Math.min(
    settings.defaultMessageCount,
    config.GIF_DEFAULT_MESSAGE_COUNT,
    config.GIF_MAX_MESSAGE_COUNT,
  );

  let selection;
  try {
    const match = typeof ctx.match === 'string' ? ctx.match : ctx.match?.[0] ?? '';
    selection = parseSelection(match, defaultCount, config.GIF_MAX_MESSAGE_COUNT, config.RETENTION_DAYS, '/gif');
  } catch (error) {
    await ctx.reply((error as Error).message);
    return;
  }

  if (settings.summaryAdminOnly) {
    if (!ctx.from || ctx.msg?.sender_chat) {
      await ctx.reply('Для /gif отправьте команду от своего аккаунта администратора.');
      return;
    }
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['creator', 'administrator'].includes(member.status)) {
      await ctx.reply('/gif могут запрашивать только администраторы группы.');
      return;
    }
  }

  if (!claimGifSlot(chatId)) {
    await ctx.reply(`Подождите ${config.GIF_COOLDOWN_SECONDS} сек. между запросами /gif.`);
    return;
  }

  const status = await ctx.reply('⏳ Смотрю переписку и ищу смешную GIF…');
  const failText = 'Не удалось подобрать GIF. Попробуйте позже или уменьшите N.';
  const connection = await pool.connect();
  try {
    const rows = await selectMessages(chatId, selection, ctx.msg!.message_id, connection);
    if (!rows.length) {
      await ctx.api.editMessageText(chatId, status.message_id, 'Пока нет сохранённых сообщений. Проверьте Privacy Mode в @BotFather.');
      return;
    }
    const prepared = prepareMessages(rows, config.GIF_MAX_INPUT_CHARS);
    if (!prepared.count) throw new Error('Input cannot fit text budget');

    const reaction = await suggestGifReaction(prepared.json, settings.sarcasmLevel);
    await recordOpenAiUsage(chatId, {
      kind: 'gif',
      model: reaction.usage.model,
      promptTokens: reaction.usage.promptTokens,
      completionTokens: reaction.usage.completionTokens,
      imageCount: reaction.usage.imageCount,
      estimatedCostUsd: reaction.usage.estimatedCostUsd,
    }).catch(() => console.error('OpenAI usage record failed', { chatId, kind: 'gif' }));

    let urls = await searchGiphyAnimations(reaction.query);
    if (!urls.length) urls = await searchGiphyAnimations('funny reaction');
    const animationUrl = pickRandomUrl(urls);
    if (!animationUrl) {
      await ctx.api.editMessageText(chatId, status.message_id, `${reaction.caption}\n\n(GIF не нашлась, осталась только подпись.)`);
      return;
    }

    const caption = reaction.caption.slice(0, config.TELEGRAM_MAX_CAPTION_LENGTH);
    await ctx.api.deleteMessage(chatId, status.message_id).catch(() => {});
    await ctx.replyWithAnimation(animationUrl, { caption });
  } catch {
    console.error('GIF reaction failed', { chatId });
    await ctx.api.editMessageText(chatId, status.message_id, failText).catch(() => ctx.reply(failText));
  } finally {
    connection.release();
  }
}

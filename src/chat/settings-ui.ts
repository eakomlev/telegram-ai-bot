import { InlineKeyboard, type Context } from 'grammy';
import {
  cycleDefaultCount,
  cycleMediaCooldown,
  cycleResponseTone,
  cycleSarcasmLevel,
  defaultChatSettings,
  formatSettings,
  resolveChatSettings,
  responseToneLabel,
  saveChatSettings,
  type ChatSettings,
} from './chat-settings.js';
import { cancelAllPendingAutoAnswersForChat, deleteChatSettings } from '../core/db.js';
import { scheduleNewsIfNeeded } from '../news/news-scheduler.js';

const PREFIX = 'set:';

export async function requireChatAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.from || ctx.msg?.sender_chat) {
    await ctx.reply('Команда доступна только с личного аккаунта администратора.');
    return false;
  }
  const member = await ctx.getChatMember(ctx.from.id);
  if (!['creator', 'administrator'].includes(member.status)) {
    await ctx.reply('Команду могут использовать только администраторы группы.');
    return false;
  }
  return true;
}

function settingsKeyboard(settings: ChatSettings) {
  const on = (value: boolean) => (value ? '✅' : '❌');
  return new InlineKeyboard()
    .text(`${on(settings.summaryAdminOnly)} Саммари: только админы`, `${PREFIX}admin`)
    .row()
    .text(`Число сообщений: ${settings.defaultMessageCount}`, `${PREFIX}count`)
    .row()
    .text(`Сарказм: ${settings.sarcasmLevel}%`, `${PREFIX}sarcasm`)
    .row()
    .text(`Тон: ${responseToneLabel(settings.responseTone)}`, `${PREFIX}tone`)
    .row()
    .text(`${on(settings.mentionEnabled)} Ответы на @упоминания`, `${PREFIX}mention`)
    .row()
    .text(`${on(settings.autoAnswerEnabled)} Автоответ на вопросы без ответа`, `${PREFIX}autoans`)
    .row()
    .text(`${on(settings.videoEnabled)} Видео`, `${PREFIX}video`)
    .text(`${on(settings.galleryEnabled)} Картинки`, `${PREFIX}gallery`)
    .row()
    .text(`Пауза медиа: ${settings.mediaCooldownSeconds}с`, `${PREFIX}cool`)
    .row()
    .text(`${on(settings.newsEnabled)} Ежедневная новость`, `${PREFIX}news`)
    .row()
    .text('Сбросить', `${PREFIX}reset`)
    .text('Закрыть', `${PREFIX}close`);
}

export async function replyWithSettings(ctx: Context) {
  if (!(await requireChatAdmin(ctx))) return;
  const settings = await resolveChatSettings(ctx.chat!.id);
  await ctx.reply(formatSettings(settings), { reply_markup: settingsKeyboard(settings) });
}

async function applyAction(
  settings: ChatSettings,
  action: string,
  chatId: number,
): Promise<ChatSettings | 'close' | null> {
  switch (action) {
    case 'admin':
      return saveChatSettings(chatId, { ...settings, summaryAdminOnly: !settings.summaryAdminOnly });
    case 'video':
      return saveChatSettings(chatId, { ...settings, videoEnabled: !settings.videoEnabled });
    case 'gallery':
      return saveChatSettings(chatId, { ...settings, galleryEnabled: !settings.galleryEnabled });
    case 'count':
      return saveChatSettings(chatId, {
        ...settings,
        defaultMessageCount: cycleDefaultCount(settings.defaultMessageCount),
      });
    case 'cool':
      return saveChatSettings(chatId, {
        ...settings,
        mediaCooldownSeconds: cycleMediaCooldown(settings.mediaCooldownSeconds),
      });
    case 'sarcasm':
      return saveChatSettings(chatId, {
        ...settings,
        sarcasmLevel: cycleSarcasmLevel(settings.sarcasmLevel),
      });
    case 'tone':
      return saveChatSettings(chatId, {
        ...settings,
        responseTone: cycleResponseTone(settings.responseTone),
      });
    case 'mention':
      return saveChatSettings(chatId, { ...settings, mentionEnabled: !settings.mentionEnabled });
    case 'autoans': {
      const enabled = !settings.autoAnswerEnabled;
      const next = await saveChatSettings(chatId, { ...settings, autoAnswerEnabled: enabled });
      if (!enabled) {
        await cancelAllPendingAutoAnswersForChat(chatId).catch(() =>
          console.error('Cancel pending auto-answers failed', { chatId }),
        );
      }
      return next;
    }
    case 'news': {
      const next = await saveChatSettings(chatId, { ...settings, newsEnabled: !settings.newsEnabled });
      await scheduleNewsIfNeeded(chatId, next);
      return next;
    }
    case 'reset':
      await deleteChatSettings(chatId);
      await cancelAllPendingAutoAnswersForChat(chatId).catch(() =>
        console.error('Cancel pending auto-answers failed', { chatId }),
      );
      return defaultChatSettings();
    case 'close':
      return 'close';
    default:
      return null;
  }
}

export async function handleSettingsCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(PREFIX) || !ctx.chat) return false;
  const action = data.slice(PREFIX.length);
  if (!ctx.from) {
    await ctx.answerCallbackQuery({ text: 'Нужен личный аккаунт администратора', show_alert: true });
    return true;
  }
  const member = await ctx.getChatMember(ctx.from.id);
  if (!['creator', 'administrator'].includes(member.status)) {
    await ctx.answerCallbackQuery({ text: 'Только для администраторов', show_alert: true });
    return true;
  }

  const current = await resolveChatSettings(ctx.chat.id);
  if (action === 'news_menu' || action === 'back' || action.startsWith('ns:')) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(formatSettings(current), { reply_markup: settingsKeyboard(current) }).catch(() => {});
    return true;
  }
  const next = await applyAction(current, action, ctx.chat.id);
  if (next === null) {
    await ctx.answerCallbackQuery();
    return true;
  }
  if (next === 'close') {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    return true;
  }
  await ctx.answerCallbackQuery({ text: 'Сохранено' });
  await ctx.editMessageText(formatSettings(next), { reply_markup: settingsKeyboard(next) }).catch(() => {});
  return true;
}

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
import { cancelAllPendingAutoAnswersForChat, deleteChatSettings } from './db.js';
import { isNewsSphereId, NEWS_SPHERES } from './news-spheres.js';
import { scheduleNewsIfNeeded } from './news-scheduler.js';

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
    .text(`${on(settings.personalizationEnabled)} Персонализация участников`, `${PREFIX}person`)
    .row()
    .text(`${on(settings.videoEnabled)} Видео`, `${PREFIX}video`)
    .text(`${on(settings.galleryEnabled)} Картинки`, `${PREFIX}gallery`)
    .row()
    .text(`Пауза медиа: ${settings.mediaCooldownSeconds}с`, `${PREFIX}cool`)
    .row()
    .text(`${on(settings.newsEnabled)} Ежедневная новость`, `${PREFIX}news`)
    .row()
    .text('Сферы новостей…', `${PREFIX}news_menu`)
    .row()
    .text('Сбросить', `${PREFIX}reset`)
    .text('Закрыть', `${PREFIX}close`);
}

function newsMenuKeyboard(settings: ChatSettings) {
  const on = (value: boolean) => (value ? '✅' : '❌');
  const keyboard = new InlineKeyboard();
  for (const [index, sphere] of NEWS_SPHERES.entries()) {
    const selected = settings.newsSpheres.includes(sphere.id);
    keyboard.text(`${on(selected)} ${sphere.label}`, `${PREFIX}ns:${sphere.id}`);
    if (index % 2 === 1) keyboard.row();
  }
  if (NEWS_SPHERES.length % 2 === 1) keyboard.row();
  keyboard.text('← Назад', `${PREFIX}back`);
  return keyboard;
}

function formatNewsMenu(settings: ChatSettings) {
  const spheres = settings.newsSpheres.length
    ? settings.newsSpheres.map((id) => NEWS_SPHERES.find((s) => s.id === id)?.label ?? id).join(', ')
    : 'пока ничего не выбрано';
  return [
    'Сферы ежедневной новости:',
    'Выберите одну или несколько тем. Раз в день бот пришлёт одну свежую новость по случайной из выбранных.',
    '',
    `Сейчас: ${spheres}`,
  ].join('\n');
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
): Promise<ChatSettings | 'close' | 'news_menu' | 'back' | null> {
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
    case 'person':
      return saveChatSettings(chatId, {
        ...settings,
        personalizationEnabled: !settings.personalizationEnabled,
      });
    case 'news': {
      const next = await saveChatSettings(chatId, { ...settings, newsEnabled: !settings.newsEnabled });
      await scheduleNewsIfNeeded(chatId, next);
      return next;
    }
    case 'news_menu':
      return 'news_menu';
    case 'back':
      return 'back';
    case 'reset':
      await deleteChatSettings(chatId);
      await cancelAllPendingAutoAnswersForChat(chatId).catch(() =>
        console.error('Cancel pending auto-answers failed', { chatId }),
      );
      return defaultChatSettings();
    case 'close':
      return 'close';
    default:
      if (action.startsWith('ns:')) {
        const id = action.slice(3);
        if (!isNewsSphereId(id)) return null;
        const has = settings.newsSpheres.includes(id);
        const newsSpheres = has
          ? settings.newsSpheres.filter((sphere) => sphere !== id)
          : [...settings.newsSpheres, id];
        const next = await saveChatSettings(chatId, { ...settings, newsSpheres });
        await scheduleNewsIfNeeded(chatId, next);
        return next;
      }
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
  if (next === 'news_menu') {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(formatNewsMenu(current), { reply_markup: newsMenuKeyboard(current) }).catch(() => {});
    return true;
  }
  if (next === 'back') {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(formatSettings(current), { reply_markup: settingsKeyboard(current) }).catch(() => {});
    return true;
  }
  await ctx.answerCallbackQuery({ text: 'Сохранено' });
  const showNewsMenu = action === 'news_menu' || action.startsWith('ns:');
  if (showNewsMenu) {
    await ctx.editMessageText(formatNewsMenu(next), { reply_markup: newsMenuKeyboard(next) }).catch(() => {});
  } else {
    await ctx.editMessageText(formatSettings(next), { reply_markup: settingsKeyboard(next) }).catch(() => {});
  }
  return true;
}

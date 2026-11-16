import { Bot, type Context } from 'grammy';
import { config, allowedChatIds, ownerUserId } from './config.js';
import { resolveChatSettings } from './chat-settings.js';
import {
  pool,
  initializeDatabase,
  saveMessage,
  selectMessages,
  claimSummary,
  cleanup,
  deleteMessage,
  getGlobalOpenAiUsageTotals,
  getOpenAiUsageByChat,
  getOpenAiUsageTotals,
  countNewOpenAiUsageChats,
  countOpenAiUsageChats,
  getLatestChatMemberCounts,
  getTotalLatestChatMembers,
  recordOpenAiUsage,
} from './db.js';
import { summarize, type SummaryStyle } from './ai.js';
import { parseSelection, prepareMessages, splitReply } from './summary.js';
import { handleSettingsCallback, replyWithSettings, requireChatAdmin } from './settings-ui.js';
import { formatOwnerUsageReport, formatUsageReport } from './usage.js';
import { runDailyMemberSnapshots } from './chat-members.js';

import { runGifReaction } from './gif.js';
import { cancelPendingAutoAnswersForActivity, maybeEnqueueAutoAnswer } from './auto-answer.js';
import { startAutoAnswerScheduler, stopAutoAnswerScheduler } from './auto-answer-scheduler.js';
import { maybeHandleMention, setBotIdentity } from './mention.js';
import { maybeRepostVideo } from './video.js';
import { maybeRepostGallery } from './gallery.js';
import { stopMediaJobs } from './media-jobs.js';
import { startNewsScheduler, stopNewsScheduler } from './news-scheduler.js';

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
let cleanupTimer: NodeJS.Timeout | undefined;
let stopping = false;
const help = `Я сохраняю текстовые сообщения и подписи к медиа в этой группе и составляю саммари через OpenAI.

/summary — последние сообщения (число задаётся в /settings)
/summary 500 — последние 500 сообщений (максимум ${config.MAX_MESSAGE_COUNT})
/summary 24h — за сутки
/summary 7d — за неделю
/verse — то же самое, но саммари в стихах
/verse 24h — стихотворное саммари за сутки
/gif — по последним сообщениям подобрать шуточную GIF-реакцию
/gif 40 — то же по 40 сообщениям (можно 24h / 7d)
/settings — настройки группы (только администраторы)
/usage — оценка расходов OpenAI по этой группе (админы)
/privacy — обработка данных
/chatid — ID группы для настройки доступа

В /settings можно включить ежедневную интересную новость (случайное время 10:00–21:00 по Москве) по выбранным сферам.

Там же можно включить автоответ на вопросы без ответа: если общий вопрос в чат (без @упоминаний и без ответа-цитаты) останется без реакции участников ~5 минут, бот мягко ответит через OpenAI.

Упомяните меня (@бот) в сообщении — отвечу через OpenAI. Текст и картинки из сообщения и из цитаты учитываю как контекст; в ответе тоже могу прислать картинку.
Если в запросе есть слова вроде «мем», «демотиватор», «drake» — сделаю мем-картинку.

Отправьте отдельным сообщением ссылку на YouTube Shorts, TikTok, Instagram Reels или VK Клип — я загружу видео без подписи.

Ссылку на пост с картинками (Instagram, X, Reddit, Pixiv или Imgur) отправлю альбомом.
Ссылку на товар Wildberries — пришлю фото и название.

История до добавления бота недоступна. По умолчанию саммари могут запрашивать только администраторы.`;

function isBotOwner(ctx: Context) {
  return Boolean(ownerUserId && ctx.from?.id === ownerUserId && !ctx.msg?.sender_chat);
}

async function chatUsageLabel(chatId: number) {
  try {
    const chat = await bot.api.getChat(chatId);
    const title = 'title' in chat && chat.title ? chat.title : undefined;
    return title ? `${title} (${chatId})` : String(chatId);
  } catch {
    return String(chatId);
  }
}

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'private') {
    const text = ctx.message?.text ?? '';
    if (isBotOwner(ctx) && /^\/stats(?:@\w+)?(?:\s|$)/i.test(text)) {
      await next();
      return;
    }
    if (text.startsWith('/')) {
      await ctx.reply(
        ownerUserId && isBotOwner(ctx)
          ? 'В личке доступна только /stats — статистика OpenAI по всем группам.'
          : 'Добавьте меня в групповой чат. Настройка: /setprivacy → Disable в @BotFather.',
      );
    }
    return;
  }
  if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) return;
  if (allowedChatIds.size && !allowedChatIds.has(String(ctx.chat.id))) return;
  await next();
});

/** Any human activity (commands, stickers, photos, voice, text, …) cancels unanswered waits. */
bot.use(async (ctx, next) => {
  if (ctx.message && !(ctx.message.from?.is_bot && !ctx.message.sender_chat)) {
    await cancelPendingAutoAnswersForActivity(ctx).catch(() => {});
  }
  await next();
});

bot.command(['start', 'help'], (ctx) => ctx.reply(help));
bot.command('chatid', (ctx) => ctx.reply(`ID группы: ${ctx.chat.id}`));
bot.command('settings', (ctx) => replyWithSettings(ctx));
bot.command('usage', async (ctx) => {
  if (!(await requireChatAdmin(ctx))) return;
  const chatId = ctx.chat!.id;
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const [today, total] = await Promise.all([
    getOpenAiUsageTotals(chatId, startOfUtcDay),
    getOpenAiUsageTotals(chatId),
  ]);
  await ctx.reply(formatUsageReport(today, total), { link_preview_options: { is_disabled: true } });
});
bot.command('stats', async (ctx) => {
  if (ctx.chat?.type !== 'private' || !isBotOwner(ctx)) return;
  if (!ownerUserId) {
    await ctx.reply('Задайте OWNER_USER_ID в .env и перезапустите бота.');
    return;
  }
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const [today, total, chatRows, todayByChat, newGroupsToday, totalGroups, memberCounts, totalMembers] = await Promise.all([
    getGlobalOpenAiUsageTotals(startOfUtcDay),
    getGlobalOpenAiUsageTotals(),
    getOpenAiUsageByChat(undefined, 30),
    getOpenAiUsageByChat(startOfUtcDay, 100),
    countNewOpenAiUsageChats(startOfUtcDay),
    countOpenAiUsageChats(),
    getLatestChatMemberCounts(),
    getTotalLatestChatMembers(),
  ]);
  const todayMap = new Map(todayByChat.map((row) => [row.chatId, row]));
  const emptyToday = {
    requests: 0,
    summaryRequests: 0,
    mentionRequests: 0,
    gifRequests: 0,
    newsRequests: 0,
    autoAnswerRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    imageCount: 0,
    estimatedCostUsd: 0,
  };
  const chats = await Promise.all(chatRows.map(async (row) => ({
    chatId: row.chatId,
    label: await chatUsageLabel(row.chatId),
    today: todayMap.get(row.chatId) ?? emptyToday,
    total: row,
    members: memberCounts.get(row.chatId),
  })));
  const report = formatOwnerUsageReport(today, total, chats, {
    newToday: newGroupsToday,
    total: totalGroups,
    members: totalMembers,
  });
  for (const part of splitReply(report, config.TELEGRAM_MAX_MESSAGE_LENGTH)) {
    await ctx.reply(part, { link_preview_options: { is_disabled: true } });
  }
});
bot.command('privacy', (ctx) => ctx.reply(
  `Бот сохраняет текст, подписи к медиа, отображаемое имя автора, время и ID сообщений в Postgres на ${config.RETENTION_DAYS} дней. ` +
  `Учёт токенов и оценочных расходов OpenAI, а также ежедневные снимки числа участников групп, хранятся ${config.USAGE_RETENTION_DAYS} дней. ` +
  'При /summary, /gif, ежедневных новостях, @упоминаниях и (если включено в /settings) автоответах на вопросы без ответа данные уходят в OpenAI API; для /gif поисковый запрос уходит в Giphy; ответ виден участникам группы. ' +
  'Ссылки на видео и посты с картинками передаются соответствующему сервису для скачивания; временные файлы удаляются после отправки. Фото, аудио и файлы не анализируются. Удаления Telegram не сообщает: удалённый текст может оставаться до очистки. ' +
  'Администратору следует предупредить участников. Доступ и удаление данных — через владельца бота.',
));

bot.on('callback_query:data', async (ctx) => {
  if (await handleSettingsCallback(ctx)) return;
  await ctx.answerCallbackQuery().catch(() => {});
});

async function runSummary(ctx: Context, style: SummaryStyle) {
  const settings = await resolveChatSettings(ctx.chat!.id);
  let selection;
  try {
    const match = typeof ctx.match === 'string' ? ctx.match : ctx.match?.[0] ?? '';
    selection = parseSelection(match, settings.defaultMessageCount, config.MAX_MESSAGE_COUNT, config.RETENTION_DAYS);
  } catch (error) {
    await ctx.reply((error as Error).message);
    return;
  }
  if (settings.summaryAdminOnly) {
    if (!ctx.from || ctx.msg?.sender_chat) {
      await ctx.reply('Для запроса саммари отправьте команду от своего аккаунта администратора.');
      return;
    }
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['creator', 'administrator'].includes(member.status)) {
      await ctx.reply('Саммари могут запрашивать только администраторы группы.');
      return;
    }
  }
  // Dedicated session keeps the advisory lock through DB reads and the model request.
  const connection = await pool.connect();
  let locked = false;
  try {
    const lock = await connection.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS locked', [String(ctx.chat!.id)]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      await ctx.reply('Саммари для этой группы уже готовится.');
      return;
    }
    const rows = await selectMessages(ctx.chat!.id, selection, ctx.msg!.message_id, connection);
    if (!rows.length) {
      await ctx.reply('Пока нет сохранённых сообщений за этот период. Проверьте Privacy Mode в @BotFather.');
      return;
    }
    if (!(await claimSummary(ctx.chat!.id, connection))) {
      await ctx.reply(`Слишком частые запросы. Между саммари нужно подождать ${config.SUMMARY_COOLDOWN_SECONDS} сек.`);
      return;
    }
    const prepared = prepareMessages(rows, config.MAX_INPUT_CHARS);
    if (!prepared.count) throw new Error('Input cannot fit text budget');
    const failText = 'Не удалось составить саммари. Попробуйте позже; владельцу бота стоит проверить подключение, модель и баланс OpenAI.';
    const status = await ctx.reply(style === 'verse' ? '⏳ Сочиняю саммари в стихах…' : '⏳ Готовлю саммари…');
    try {
      const { text: summary, usage } = await summarize(prepared.json, settings.sarcasmLevel, style);
      await recordOpenAiUsage(ctx.chat!.id, {
        kind: 'summary',
        model: usage.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        imageCount: usage.imageCount,
        estimatedCostUsd: usage.estimatedCostUsd,
      }).catch(() => console.error('OpenAI usage record failed', { chatId: ctx.chat!.id, kind: 'summary' }));
      const capped = prepared.limited || (selection.kind === 'hours' && rows.length === config.MAX_MESSAGE_COUNT);
      const title = style === 'verse' ? 'Саммари в стихах' : 'Саммари';
      const header = `${title} по ${prepared.count} сообщениям${capped ? ' (сработал лимит объёма: взяты самые свежие сообщения; длинное сообщение могло быть обрезано)' : ''}:\n\n`;
      const parts = splitReply(header + summary, config.TELEGRAM_MAX_MESSAGE_LENGTH);
      const preview = { link_preview_options: { is_disabled: true } };
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, parts[0]!, preview);
      for (const part of parts.slice(1)) await ctx.reply(part, preview);
    } catch {
      console.error('Summary request failed', { chatId: ctx.chat!.id, style });
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, failText).catch(() => ctx.reply(failText));
    }
  } catch {
    console.error('Summary request failed', { chatId: ctx.chat!.id, style });
    await ctx.reply('Не удалось составить саммари. Попробуйте позже; владельцу бота стоит проверить подключение, модель и баланс OpenAI.');
  } finally {
    if (locked) {
      try { await connection.query('SELECT pg_advisory_unlock($1::bigint)', [String(ctx.chat!.id)]); }
      catch { connection.release(true); return; }
    }
    connection.release();
  }
}

bot.command('summary', (ctx) => runSummary(ctx, 'plain'));
bot.command('verse', (ctx) => runSummary(ctx, 'verse'));
bot.command('gif', (ctx) => runGifReaction(ctx));

async function store(ctx: Context) {
  const message = ctx.message ?? ctx.editedMessage;
  if (!message || (message.from?.is_bot && !message.sender_chat)) return;
  const text = message.text ?? message.caption;
  if (!text || /^\/[\w]+(?:@\w+)?(?:\s|$)/.test(text)) {
    if (ctx.editedMessage) await deleteMessage(message.chat.id, message.message_id);
    return;
  }
  const author = message.sender_chat?.title ??
    [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ?? 'Участник';
  await saveMessage(message.chat.id, {
    message_id: message.message_id,
    author: author || 'Участник',
    text,
    sent_at: new Date(message.date * 1000),
    message_thread_id: message.message_thread_id ?? null,
  });
  if (ctx.message) {
    if (await maybeHandleMention(ctx)) return;
    await maybeEnqueueAutoAnswer(ctx);
    await maybeRepostVideo(ctx);
    await maybeRepostGallery(ctx);
  }
}
bot.on(['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'], store);
bot.catch(() => console.error('Telegram update failed'));

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (cleanupTimer) clearInterval(cleanupTimer);
  stopNewsScheduler();
  stopAutoAnswerScheduler();
  await stopMediaJobs();
  if (bot.isRunning()) await bot.stop();
  await pool.end();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

try {
  await initializeDatabase();
  await cleanup();
  cleanupTimer = setInterval(() => {
    void cleanup().catch(() => console.error('Retention cleanup failed'));
    void runDailyMemberSnapshots(bot.api).catch(() => console.error('Member snapshot failed'));
  }, config.RETENTION_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  startNewsScheduler(bot.api);
  startAutoAnswerScheduler(bot.api);
  const me = await bot.api.getMe();
  if (!me.username) throw new Error('Bot username is required for @mentions');
  setBotIdentity(me.id, me.username);
  const groupCommands = [
    { command: 'summary', description: 'Саммари: N, 24h или 7d' },
    { command: 'verse', description: 'Саммари в стихах: N, 24h или 7d' },
    { command: 'gif', description: 'Шуточная GIF по последним сообщениям' },
    { command: 'settings', description: 'Настройки группы (админы)' },
    { command: 'usage', description: 'Расходы OpenAI по группе (админы)' },
    { command: 'help', description: 'Как пользоваться ботом' },
    { command: 'privacy', description: 'Обработка данных' },
    { command: 'chatid', description: 'ID этой группы' },
  ];
  await bot.api.setMyCommands(groupCommands);
  await bot.api.setMyCommands(groupCommands, { scope: { type: 'all_group_chats' } });
  await bot.api.setMyCommands(
    [{ command: 'stats', description: 'Расходы OpenAI по всем группам' }],
    { scope: { type: 'all_private_chats' } },
  );
  await bot.start({
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    onStart: () => {
      console.log(`Telegram summary bot started as @${me.username}`);
      void runDailyMemberSnapshots(bot.api).catch(() => console.error('Member snapshot failed'));
    },
  });
} catch {
  console.error('Startup or polling failed. Check configuration and service connectivity.');
  await shutdown();
  process.exitCode = 1;
}

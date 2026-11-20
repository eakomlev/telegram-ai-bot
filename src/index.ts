import { Bot, type Context } from 'grammy';
import { aiJobs, enqueueAi } from './core/ai-jobs.js';
import { config, allowedChatIds, ownerUserId } from './config.js';
import { resolveChatSettings } from './chat/chat-settings.js';
import {
  pool,
  saveMessage,
  selectMessages,
  claimSummary,
  cleanup,
  deleteMessage,
  ensureChatSettingsDefaults,
  getChatMemory,
  getOpenAiUsageTotals,
  countNewOpenAiUsageChats,
  listChatStatsForOwner,
  sumNewChatMembersSince,
  recordOpenAiUsage,
} from './core/db.js';
import { migrate } from './core/migrate.js';
import { summarize, type SummaryStyle } from './ai/ai.js';
import { parseSelection, prepareMessages, splitReply } from './summary/summary.js';
import { forgetChatFact, rememberChatFact, replyWithChatMemory } from './chat/chat-memory-commands.js';
import { startChatMemoryScheduler, stopChatMemoryScheduler } from './chat/chat-memory-scheduler.js';
import { handleMemoryRefreshCallback, replyWithMemoryRefreshPicker } from './chat/chat-memory-refresh-ui.js';
import { handleChatCheckCallback, replyWithChatCheckConfirm } from './chat/chat-gc-ui.js';
import { handleNewsPreviewCallback, replyWithNewsPreviewPicker } from './news/news-preview-ui.js';
import { formatChatMemoryBlock } from './chat/chat-memory.js';
import { handleSettingsCallback, replyWithSettings, requireChatAdmin } from './chat/settings-ui.js';
import { formatOwnerStatsReport, formatUsageReport } from './ai/usage.js';
import { fetchOrganizationCostsMtd, formatOrganizationCostsReport } from './ai/openai-costs.js';
import { moscowDateString, moscowMonthStart } from './core/moscow-time.js';
import { runDailyMemberSnapshots } from './chat/chat-members.js';
import {
  privateBlockedReplyText,
  shouldPassPrivateMiddleware,
  shouldReplyToBlockedPrivate,
} from './core/private-gate.js';
import { buildCommandRegistrationPlan } from './core/bot-commands.js';
import { shouldSendBotJoinWelcome } from './chat/bot-join.js';
import { startStatus } from './core/status.js';

import { runGifReaction } from './gif/gif.js';
import { cancelPendingAutoAnswersForActivity, cancelAutoAnswerForEdit, maybeEnqueueAutoAnswer } from './auto-answer/auto-answer.js';
import { startAutoAnswerScheduler, stopAutoAnswerScheduler } from './auto-answer/auto-answer-scheduler.js';
import { startChatGcScheduler, stopChatGcScheduler } from './chat/chat-gc-scheduler.js';
import { maybeHandleMention, setBotIdentity } from './mention/mention.js';
import { maybeRepostVideo } from './media/video.js';
import { maybeRepostGallery } from './media/gallery.js';
import { stopMediaJobs } from './core/media-jobs.js';
import { startNewsScheduler, stopNewsScheduler } from './news/news-scheduler.js';

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
let cleanupTimer: NodeJS.Timeout | undefined;
let stopping = false;
const help = `Я сохраняю текстовые сообщения и подписи к медиа в этой группе и составляю саммари.

/summary — последние сообщения (число задаётся в /settings)
/summary 500 — последние 500 сообщений (максимум ${config.MAX_MESSAGE_COUNT})
/summary 24h — за сутки
/summary 7d — за неделю
/verse — то же самое, но саммари в стихах
/verse 24h — стихотворное саммари за сутки
/gif — по последним сообщениям подобрать шуточную GIF-реакцию
/gif 40 — то же по 40 сообщениям (можно 24h / 7d)
/settings — настройки группы (только администраторы)
/memory — память чата и закреплённые факты (только администраторы)
/remember текст — добавить закреплённый факт
/forget — очистить закреплённые факты; /forget N — удалить факт номер N
/usage — токены по группе за текущий месяц (админы)
/privacy — обработка данных
/chatid — ID группы для настройки доступа

В /settings можно включить ежедневную интересную новость (случайное время 10:00–21:00 по Москве). Тема берётся из памяти чата.

Там же можно включить автоответ на вопросы без ответа: если общий вопрос в чат (без @упоминаний и без ответа-цитаты) останется без реакции участников ~5 минут, бот мягко ответит (с коротким окном недавних сообщений до вопроса как контекстом).

Упомяните меня (@бот) в сообщении или ответьте на моё сообщение — отвечу. Учитываю сам запрос, цитату, цепочку ответов на цитату, короткое окно сообщений рядом со старой цитатой и более широкое окно недавних сообщений. Ночная память чата и закреплённые факты — только фон.

Отправьте отдельным сообщением ссылку на YouTube Shorts, TikTok, Instagram Reels или VK Клип — я загружу видео без подписи.

История до добавления бота недоступна. По умолчанию саммари могут запрашивать только администраторы.`;

/** Short intro for when the bot is added to a group — aimed at regular members, not admins. */
const joinWelcome = `Привет! Я в чате.

Могу коротко рассказать, чем полезен участникам:
• упомяните меня (@бот) или ответьте на моё сообщение — отвечу;
• киньте отдельным сообщением ссылку на YouTube Shorts, TikTok, Instagram Reels или VK Клип — скачаю видео;
• /gif — шуточная GIF по недавним сообщениям;
• /summary и /verse — саммари переписки (иногда только для админов — смотрите настройки чата).

Историю до моего появления в чате я не вижу.

Подробности команд и настроек — в /help.`;

function isBotOwner(ctx: Context) {
  return Boolean(ownerUserId && ctx.from?.id === ownerUserId && !ctx.msg?.sender_chat);
}

/** Telegram title with chat id in parentheses; otherwise the numeric chat id. */
async function chatTitleOrId(chatId: number) {
  try {
    const chat = await bot.api.getChat(chatId);
    const title = 'title' in chat && chat.title ? chat.title : undefined;
    return title ? `${title} (${chatId})` : String(chatId);
  } catch {
    return String(chatId);
  }
}

bot.use(async (ctx, next) => {
  if (stopping) return;
  if (ctx.chat?.type === 'private') {
    // Callbacks have no message text; pass through so set: handlers can run.
    // Auth stays in the callback handlers (owner / admin checks).
    const messageText = ctx.message?.text ?? '';
    const isOwner = isBotOwner(ctx);
    if (
      shouldPassPrivateMiddleware({
        hasCallbackQuery: Boolean(ctx.callbackQuery),
        messageText,
        isOwner,
      })
    ) {
      await next();
      return;
    }
    if (shouldReplyToBlockedPrivate({ hasMessage: Boolean(ctx.message) })) {
      await ctx.reply(privateBlockedReplyText({ isOwner, messageText }));
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
bot.command('memory', (ctx) => replyWithChatMemory(ctx));
bot.command('remember', (ctx) => rememberChatFact(ctx));
bot.command('forget', (ctx) => forgetChatFact(ctx));
bot.command('usage', async (ctx) => {
  if (!(await requireChatAdmin(ctx))) return;
  const chatId = ctx.chat!.id;
  const month = await getOpenAiUsageTotals(chatId, moscowMonthStart());
  await ctx.reply(formatUsageReport(month), { link_preview_options: { is_disabled: true } });
});
bot.command('costs', async (ctx) => {
  if (ctx.chat?.type !== 'private' || !isBotOwner(ctx)) return;
  if (!ownerUserId) {
    await ctx.reply('Задайте OWNER_USER_ID в .env и перезапустите бота.');
    return;
  }
  if (!config.OPENAI_ADMIN_API_KEY.trim()) {
    await ctx.reply(
      'Для /costs задайте OPENAI_ADMIN_API_KEY в .env (отдельный Admin API key организации OpenAI, не OPENAI_API_KEY) и перезапустите бота.',
    );
    return;
  }
  const now = new Date();
  const monthStart = moscowMonthStart(now);
  if (Math.floor(now.getTime() / 1000) <= Math.floor(monthStart.getTime() / 1000)) {
    await ctx.reply('Пока нет данных за текущий месяц (Europe/Moscow).');
    return;
  }
  const status = await startStatus(ctx, '⏳ Запрашиваю расходы OpenAI…');
  try {
    const report = await fetchOrganizationCostsMtd({ now });
    await status.clear();
    let text = formatOrganizationCostsReport(report);
    if (report.truncated) {
      text += '\n\n(Ответ Admin API обрезан по лимиту страниц — сумма может быть неполной.)';
    }
    await ctx.reply(text, { link_preview_options: { is_disabled: true } });
  } catch (error) {
    console.error('OpenAI organization costs failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    await status.fail('Не удалось получить расходы OpenAI. Попробуйте позже.');
  }
});
bot.command('memory_refresh', (ctx) => replyWithMemoryRefreshPicker(ctx));
bot.command('check_chats', (ctx) => replyWithChatCheckConfirm(ctx));
bot.command('news_preview', (ctx) => replyWithNewsPreviewPicker(ctx));
bot.command('stats', async (ctx) => {
  if (ctx.chat?.type !== 'private' || !isBotOwner(ctx)) return;
  if (!ownerUserId) {
    await ctx.reply('Задайте OWNER_USER_ID в .env и перезапустите бота.');
    return;
  }
  const monthStart = moscowMonthStart();
  const monthStartDate = moscowDateString(monthStart);
  const [newChatsThisMonth, newMembersThisMonth, chatRows] = await Promise.all([
    countNewOpenAiUsageChats(monthStart),
    sumNewChatMembersSince(monthStartDate),
    listChatStatsForOwner(),
  ]);
  const chats = await Promise.all(
    chatRows.map(async (row) => ({
      name: await chatTitleOrId(row.chatId),
      members: row.members,
      tokens: row.tokens,
    })),
  );
  const report = formatOwnerStatsReport({
    newChatsThisMonth,
    newMembersThisMonth,
    chats,
  });
  for (const part of splitReply(report, config.TELEGRAM_MAX_MESSAGE_LENGTH)) {
    await ctx.reply(part, { link_preview_options: { is_disabled: true } });
  }
});
bot.command('privacy', (ctx) => ctx.reply(
  `Бот сохраняет текст и подписи участников, а также текст и подписи исходящих ответов бота на @упоминания и автоответы (сами изображения не сохраняются; не саммари, стихи, GIF, новости и служебные сообщения), ` +
  `отображаемое имя автора, ID пользователя (для обычных аккаунтов), время, ID сообщений, ID сообщения, на которое ответили (reply_to_message_id), и (для тем форума) ID темы в Postgres на ${config.RETENTION_DAYS} дней. ` +
  `Раз в сутки может сохраняться короткое описание чата и отправляться в OpenAI вместе с @упоминаниями, автоответами и саммари. Закреплённые факты администратора (/remember) тоже могут уходить в OpenAI. ` +
  `Память и закреплённые факты удаляются вместе с данными чата, если чат стал недоступен. ` +
  `Учёт токенов и оценочных расходов OpenAI, а также ежедневные снимки числа участников групп, хранятся ${config.USAGE_RETENTION_DAYS} дней. ` +
  'При /summary, /gif, ежедневных новостях, @упоминаниях и (если включено в /settings) автоответах на вопросы без ответа данные уходят в OpenAI API; ' +
  'для @упоминания модель может получить запрос, цитату, цепочку ответов на цитату, короткое окно рядом с цитатой и более широкое окно недавних сообщений (включая ранее сохранённые текст и подписи ответов бота; та же тема форума или чат целиком). ' +
  'Для автоответа передаётся окно недавних сообщений до вопроса и, если вопрос сам является ответом, цепочка обсуждения. ' +
  'Ответы /summary, /verse, /gif и новости в историю переписки для контекста не сохраняются. ' +
  'Для /gif поисковый запрос уходит в Giphy; ответ виден участникам группы. ' +
  'Ссылки на видео передаются соответствующему сервису для скачивания; временные файлы удаляются после отправки. Фото, аудио и файлы не анализируются. Удаления Telegram не сообщает: удалённый текст может оставаться до очистки. ' +
  'Администратору следует предупредить участников. Доступ и удаление данных — через владельца бота.',
));

bot.on('callback_query:data', async (ctx) => {
  if (await handleSettingsCallback(ctx)) return;
  if (await handleMemoryRefreshCallback(ctx)) return;
  if (await handleChatCheckCallback(ctx)) return;
  if (await handleNewsPreviewCallback(ctx)) return;
  await ctx.answerCallbackQuery().catch(() => {});
});

bot.on('my_chat_member', async (ctx) => {
  const u = ctx.myChatMember;
  if (!u || !ctx.chat) return;
  if (
    !shouldSendBotJoinWelcome({
      chatType: ctx.chat.type,
      chatId: ctx.chat.id,
      oldStatus: u.old_chat_member.status,
      newStatus: u.new_chat_member.status,
      allowedChatIds,
    })
  ) {
    return;
  }
  try {
    await ctx.reply(joinWelcome);
  } catch (error) {
    console.error('Join welcome failed', {
      chatId: ctx.chat.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
  const connection = await pool.connect();
  let released = false;
  try {
    const rows = await selectMessages(ctx.chat!.id, selection, ctx.msg!.message_id, connection);
    if (!rows.length) {
      await ctx.reply('Пока нет сохранённых сообщений за этот период. Проверьте Privacy Mode в @BotFather.');
      return;
    }
    if (!(await claimSummary(ctx.chat!.id, connection))) {
      await ctx.reply(`Слишком частые запросы. Между саммари нужно подождать ${config.SUMMARY_COOLDOWN_SECONDS} сек.`);
      return;
    }
    connection.release();
    released = true;
    const prepared = prepareMessages(rows, config.MAX_INPUT_CHARS);
    if (!prepared.count) throw new Error('Input cannot fit text budget');
    let memoryBlock = '';
    try {
      const memory = await getChatMemory(ctx.chat!.id);
      memoryBlock = formatChatMemoryBlock({
        body: memory.body,
        pinned: memory.pinned,
        bodyMaxChars: config.CHAT_MEMORY_PROMPT_MAX_CHARS,
        pinMaxChars: config.CHAT_MEMORY_PIN_MAX_CHARS,
      });
    } catch (error) {
      console.error('Chat memory load failed', {
        chatId: ctx.chat!.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const failText = 'Не удалось составить саммари. Попробуйте позже; владельцу бота стоит проверить подключение, модель и баланс OpenAI.';
    const status = await ctx.reply(style === 'verse' ? '⏳ Сочиняю саммари в стихах…' : '⏳ Готовлю саммари…');
    try {
      const { text: summary, usage } = await summarize(
        prepared.json,
        settings.sarcasmLevel,
        style,
        settings.responseTone,
        memoryBlock,
      );
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
    if (!released) connection.release();
  }
}

bot.command('summary', (ctx) => enqueueAi(ctx, () => runSummary(ctx, 'plain')));
bot.command('verse', (ctx) => enqueueAi(ctx, () => runSummary(ctx, 'verse')));
bot.command('gif', (ctx) => enqueueAi(ctx, () => runGifReaction(ctx)));

async function store(ctx: Context) {
  const message = ctx.message ?? ctx.editedMessage;
  if (!message || (message.from?.is_bot && !message.sender_chat)) return;
  if (ctx.editedMessage) {
    await cancelAutoAnswerForEdit(message);
  }
  const text = message.text ?? message.caption;
  if (!text || /^\/[\w]+(?:@\w+)?(?:\s|$)/.test(text)) {
    if (ctx.editedMessage) await deleteMessage(message.chat.id, message.message_id);
    return;
  }
  const author = message.sender_chat?.title ??
    [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ?? 'Участник';
  const displayName = author || 'Участник';
  const isAnonymousSenderChat = Boolean(message.sender_chat);
  const isHumanUser = Boolean(message.from && !message.from.is_bot && !isAnonymousSenderChat);
  const authorUserId = isHumanUser ? message.from!.id : null;
  const sentAt = new Date(message.date * 1000);
  await saveMessage(message.chat.id, {
    message_id: message.message_id,
    author: displayName,
    text,
    sent_at: sentAt,
    message_thread_id: message.message_thread_id ?? null,
    author_user_id: authorUserId,
    reply_to_message_id: message.reply_to_message?.message_id ?? null,
  });
  if (isHumanUser && authorUserId != null) {
    await ensureChatSettingsDefaults(message.chat.id).catch(() =>
      console.error('Ensure chat settings failed', { chatId: message.chat.id }),
    );
  }
  if (ctx.message) {
    if (await maybeHandleMention(ctx)) return;
    await maybeEnqueueAutoAnswer(ctx);
    await maybeRepostVideo(ctx);
    await maybeRepostGallery(ctx);
  }
}
bot.on(['message:text', 'message:caption', 'edited_message'], store);
bot.catch(() => console.error('Telegram update failed'));

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (cleanupTimer) clearInterval(cleanupTimer);
  const draining = Promise.allSettled([
    stopNewsScheduler(),
    stopChatMemoryScheduler(),
    stopAutoAnswerScheduler(),
    stopChatGcScheduler(),
    aiJobs.stop(),
    stopMediaJobs(),
  ]);
  try {
    if (bot.isRunning()) await bot.stop();
  } finally {
    await draining;
    await pool.end();
  }
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

try {
  await migrate();
  await cleanup();
  cleanupTimer = setInterval(() => {
    void cleanup().catch(() => console.error('Retention cleanup failed'));
    void runDailyMemberSnapshots(bot.api).catch(() => console.error('Member snapshot failed'));
  }, config.RETENTION_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  startNewsScheduler(bot.api);
  startChatMemoryScheduler();
  const me = await bot.api.getMe();
  if (!me.username) throw new Error('Bot username is required for @mentions');
  setBotIdentity(me.id, me.username);
  startAutoAnswerScheduler(bot.api);
  startChatGcScheduler(bot.api);
  for (const step of buildCommandRegistrationPlan(ownerUserId)) {
    if (step.action === 'delete') {
      await bot.api.deleteMyCommands({ scope: step.scope });
      continue;
    }
    if (step.scope.type === 'default') {
      await bot.api.setMyCommands(step.commands);
    } else {
      await bot.api.setMyCommands(step.commands, { scope: step.scope });
    }
  }
  await bot.start({
    allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
    onStart: () => {
      console.log(`Telegram summary bot started as @${me.username}`);
      void runDailyMemberSnapshots(bot.api).catch(() => console.error('Member snapshot failed'));
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'error_code' in error
      ? String((error as { error_code?: unknown }).error_code)
      : undefined;
  const conflict =
    code === '409' || /409|Conflict: terminated by other getUpdates/i.test(message);
  console.error(
    conflict
      ? 'Polling conflict (409): another getUpdates is using this bot token. Stop other instances (local npm/dev, second container, VPS).'
      : 'Startup or polling failed. Check configuration and service connectivity.',
    code ? { error_code: code, message } : { message },
  );
  if (error instanceof Error && error.stack) console.error(error.stack);
  await shutdown();
  // Avoid Docker restart thrash: a dying peer's long-poll can outlive the process for tens of seconds.
  if (conflict) await new Promise((resolve) => setTimeout(resolve, 45_000));
  process.exitCode = 1;
}

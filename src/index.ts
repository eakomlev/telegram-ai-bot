import { Bot, type Context } from 'grammy';
import { config, allowedChatIds } from './config.js';
import { pool, initializeDatabase, saveMessage, selectMessages, claimSummary, cleanup, deleteMessage } from './db.js';
import { summarize } from './ai.js';
import { parseSelection, prepareMessages, splitReply } from './summary.js';

import { maybeRepostVideo } from './video.js';
import { maybeRepostGallery } from './gallery.js';
import { stopMediaJobs } from './media-jobs.js';

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
let cleanupTimer: NodeJS.Timeout | undefined;
let stopping = false;
const help = `Я сохраняю текстовые сообщения и подписи к медиа в этой группе и составляю саммари через OpenAI.

/summary — последние ${config.DEFAULT_MESSAGE_COUNT} сообщений
/summary 500 — последние 500 сообщений (максимум ${config.MAX_MESSAGE_COUNT})
/summary 24h — за сутки
/summary 7d — за неделю
/privacy — обработка данных
/chatid — ID группы для настройки доступа

Отправьте отдельным сообщением ссылку на YouTube Shorts, TikTok, Instagram Reels или VK Клип — я загружу видео с описанием.

Ссылку на пост с картинками (Instagram, X, Reddit, Pixiv или Imgur) отправлю альбомом.

История до добавления бота недоступна. По умолчанию саммари могут запрашивать только администраторы.`;

bot.use(async (ctx, next) => {
  if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) {
    if (ctx.message?.text?.startsWith('/')) await ctx.reply('Добавьте меня в групповой чат. Настройка: /setprivacy → Disable в @BotFather.');
    return;
  }
  if (allowedChatIds.size && !allowedChatIds.has(String(ctx.chat.id))) return;
  await next();
});

bot.command(['start', 'help'], (ctx) => ctx.reply(help));
bot.command('chatid', (ctx) => ctx.reply(`ID группы: ${ctx.chat.id}`));
bot.command('privacy', (ctx) => ctx.reply(
  `Бот сохраняет текст, подписи к медиа, отображаемое имя автора, время и ID сообщений в Postgres на ${config.RETENTION_DAYS} дней. ` +
  'При /summary выбранная переписка отправляется в OpenAI API; ответ виден участникам группы. ' +
  'Ссылки на видео и посты с картинками передаются соответствующему сервису для скачивания; временные файлы удаляются после отправки. Фото, аудио и файлы не анализируются. Удаления Telegram не сообщает: удалённый текст может оставаться до очистки. ' +
  'Администратору следует предупредить участников. Доступ и удаление данных — через владельца бота.',
));

bot.command('summary', async (ctx) => {
  let selection;
  try {
    selection = parseSelection(ctx.match, config.DEFAULT_MESSAGE_COUNT, config.MAX_MESSAGE_COUNT, config.RETENTION_DAYS);
  } catch (error) {
    await ctx.reply((error as Error).message);
    return;
  }
  if (config.SUMMARY_ADMIN_ONLY === 'true') {
    if (!ctx.from || ctx.msg.sender_chat) {
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
    const lock = await connection.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS locked', [String(ctx.chat.id)]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      await ctx.reply('Саммари для этой группы уже готовится.');
      return;
    }
    const rows = await selectMessages(ctx.chat.id, selection, ctx.msg.message_id, connection);
    if (!rows.length) {
      await ctx.reply('Пока нет сохранённых сообщений за этот период. Проверьте Privacy Mode в @BotFather.');
      return;
    }
    if (!(await claimSummary(ctx.chat.id, connection))) {
      await ctx.reply(`Слишком частые запросы. Между саммари нужно подождать ${config.SUMMARY_COOLDOWN_SECONDS} сек.`);
      return;
    }
    const prepared = prepareMessages(rows, config.MAX_INPUT_CHARS);
    if (!prepared.count) throw new Error('Input cannot fit text budget');
    await ctx.reply('Готовлю саммари…');
    const summary = await summarize(prepared.json);
    const capped = prepared.limited || (selection.kind === 'hours' && rows.length === config.MAX_MESSAGE_COUNT);
    const header = `Саммари по ${prepared.count} сообщениям${capped ? ' (сработал лимит объёма: взяты самые свежие сообщения; длинное сообщение могло быть обрезано)' : ''}:\n\n`;
    for (const part of splitReply(header + summary)) {
      await ctx.reply(part, { link_preview_options: { is_disabled: true } });
    }
  } catch {
    console.error('Summary request failed', { chatId: ctx.chat.id });
    await ctx.reply('Не удалось составить саммари. Попробуйте позже; владельцу бота стоит проверить подключение, модель и баланс OpenAI.');
  } finally {
    if (locked) {
      try { await connection.query('SELECT pg_advisory_unlock($1::bigint)', [String(ctx.chat.id)]); }
      catch { connection.release(true); return; }
    }
    connection.release();
  }
});

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
  });
  if (ctx.message) {
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
  await stopMediaJobs();
  if (bot.isRunning()) await bot.stop();
  await pool.end();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

try {
  await initializeDatabase();
  await cleanup();
  cleanupTimer = setInterval(() => { void cleanup().catch(() => console.error('Retention cleanup failed')); }, 3600000);
  cleanupTimer.unref();
  await bot.api.setMyCommands([
    { command: 'summary', description: 'Саммари: 100, 24h или 7d' },
    { command: 'help', description: 'Как пользоваться ботом' },
    { command: 'privacy', description: 'Обработка данных' },
    { command: 'chatid', description: 'ID этой группы' },
  ]);
  await bot.start({
    allowed_updates: ['message', 'edited_message'],
    onStart: () => console.log('Telegram summary bot started'),
  });
} catch {
  console.error('Startup or polling failed. Check configuration and service connectivity.');
  await shutdown();
  process.exitCode = 1;
}

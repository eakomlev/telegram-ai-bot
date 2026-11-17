import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** About text in BotFather / setMyShortDescription (max 120). */
export const botShortDescription =
  'Групповой AI-бот: саммари чата, ответы по @упоминанию, GIF, новости и загрузка коротких видео и картинок.';

/** Full description in BotFather / setMyDescription (max 512). */
export const botDescription = `Бот для групповых чатов: сохраняет сообщения и делает саммари через OpenAI (/summary, /verse), отвечает на @упоминания, подбирает GIF, может присылать новости и мягко отвечать на вопросы без ответа.

Отправьте отдельной ссылкой Shorts, TikTok, Reels или VK Клип — загружу видео. Ссылка на пост с картинками или товар Wildberries — пришлю фото.

Добавьте бота в группу и отключите privacy в @BotFather (/setprivacy → Disable). Саммари по умолчанию доступны администраторам.`;

/** Private-chat welcome caption (shown with the welcome image). */
export const privateWelcome = `Я — саммари-бот для групповых чатов.

• /summary и /verse — краткое или стихотворное саммари переписки
• @упоминание — ответ через OpenAI (и мемы по запросу)
• ссылка на Shorts / TikTok / Reels / VK Клип — загружу видео
• ссылка на пост с картинками или товар WB — пришлю фото
• /settings — новости и автоответы на вопросы без ответа

Добавьте меня в группу. В @BotFather: /setprivacy → Disable.`;

const here = dirname(fileURLToPath(import.meta.url));

/** Full-size welcome banner (also for sending in private /start). */
export const welcomeImagePath = join(here, '..', 'assets', 'bot-welcome.jpg');

/** 640×360 variant recommended for BotFather description picture. */
export const welcomeImageBotFatherPath = join(here, '..', 'assets', 'bot-welcome-640x360.jpg');

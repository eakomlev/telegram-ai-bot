# Telegram AI Bot

Бот для групповых чатов Telegram: сохраняет текст и подписи, делает саммари и стихи, отвечает на @упоминания (в т.ч. с картинками и мемами), подбирает GIF-реакции, автоотвечает на вопросы без ответа, публикует ежедневные новости, репостит короткие видео и галереи (включая Wildberries). Стек: TypeScript, Node.js 22, grammY, OpenAI API, PostgreSQL 17. Запуск через Docker Compose и long polling — домен и открытый HTTP-порт не нужны.

**Важно:** на один токен бота должен работать только один polling-процесс. Несколько экземпляров без координации дадут дубли ответов и гонки планировщиков. Сообщения участников и ответы на @упоминания/автоответы уходят в OpenAI — не используйте бота для данных, которые нельзя отправлять в облако. `/usage` — токены из ответов модели по группе за месяц (МСК). Официальный биллинг организации за текущий месяц (МСК) — owner-only `/costs` через Admin API (`OPENAI_ADMIN_API_KEY`).

## Быстрый запуск

1. Создайте бота в [@BotFather](https://t.me/BotFather) (`/newbot`), сохраните токен.
2. В BotFather: `/setprivacy` → бот → **Disable**. Если бот уже был в группе — удалите и добавьте заново. Для надёжной проверки прав администраторов назначьте бота админом группы.
3. Создайте API-ключ в [OpenAI Platform](https://platform.openai.com/api-keys) и подключите оплату API.
4. Конфиг:

   ```bash
   cp .env.example .env
   ```

   Заполните `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, задайте свой `POSTGRES_PASSWORD`. Не публикуйте `.env` и ключи.
5. Запуск:

   ```bash
   docker compose up -d --build
   docker compose logs -f bot
   ```

6. Добавьте бота в группу, предупредите участников о сохранении сообщений и передаче выбранной переписки в OpenAI. Отправьте несколько сообщений, затем `/summary` от аккаунта администратора.

Схема БД применяется SQL-миграциями при старте (`src/core/migrate.ts`, baseline `001_baseline.sql`, далее `002_drop_personalization.sql` и `003_chat_memory.sql`). Новые изменения — следующие `NNN_….sql` в `src/core/migrations/`; `npm run build` копирует SQL в `dist`. Volume `postgres_data` при обычном `down` не стирается. Postgres наружу не публикуется. Перед первым запуском удалите старый webhook, если он был установлен другим приложением.

## Архитектура кода

В корне `src/` остаются только точка входа и конфиг; остальное разложено по подсистемам. Barrel-`index.ts` и path-aliases не используются; импорты ESM с суффиксом `.js`.

```
src/
  index.ts                 # grammY-бот, команды, wiring
  config.ts                # Zod + env
  core/                    # db, migrate.ts + migrations/, очереди AI/media, process, status, moscow-time
  ai/                      # OpenAI-вызовы, usage/$, openai-costs (Admin API /costs + usage tokens)
  chat/                    # настройки, контекст, память чата, снимки участников, chat GC и /check_chats
  summary/                 # выборка и нарезка текста для саммари
  mention/                 # @упоминания и reply-to-bot
  auto-answer/             # очередь и планировщик автоответов
  news/                    # генерация и планировщик новостей, сферы
  gif/                     # /gif + Giphy
  media/                   # video, gallery, marketplace (Wildberries)
```

## Команды

| Команда | Действие |
| --- | --- |
| `/summary` | Саммари последних N сообщений (N из `/settings`, иначе `DEFAULT_MESSAGE_COUNT`) |
| `/summary 500` | Последние 500 сообщений (потолок `MAX_MESSAGE_COUNT`) |
| `/summary 24h` / `/summary 7d` | За период |
| `/verse` | То же, но в виде юмористического стиха |
| `/gif` | GIF-реакция по недавним сообщениям (нужен `GIPHY_API_KEY`) |
| `/gif 40` / `/gif 24h` | То же с числом или периодом |
| `/settings` | Inline-меню настроек группы (только админы) |
| `/memory` | Память чата и закреплённые факты (только админы) |
| `/remember текст` | Добавить закреплённый факт (только админы) |
| `/forget` / `/forget N` | Очистить все закреплённые факты или удалить факт номер N |
| `/usage` | Токены за текущий месяц по группе (админы) |
| `/stats` | Рост чатов/участников за месяц (МСК) и токены по чатам — только в личке у `OWNER_USER_ID` |
| `/costs` | Официальные расходы и токены completions организации OpenAI за текущий месяц (МСК, MTD) — только в личке у `OWNER_USER_ID`; нужен `OPENAI_ADMIN_API_KEY` |
| `/memory_refresh` | Выбор группы и пересчёт памяти по сообщениям за последние 3 дня — только в личке у `OWNER_USER_ID` |
| `/check_chats` | Проверка всех известных групп и удаление данных недоступных — только в личке у `OWNER_USER_ID` |
| `/help` / `/start` | Справка |
| `/privacy` | Что сохраняется и куда уходит |
| `/chatid` | ID группы для `ALLOWED_CHAT_IDS` |

По умолчанию саммари/стихи/GIF доступны только администраторам (`SUMMARY_ADMIN_ONLY` / настройка чата). Для анонимного админа запрос нужно отправить от личного аккаунта. В личке бот просит добавить его в чат/группу; у владельца в DM работают `/stats`, `/costs`, `/memory_refresh` и `/check_chats`. Меню команд в Telegram показывает эти четыре только для `OWNER_USER_ID` (scope `chat` на личный чат владельца; `all_private_chats` пустой, чтобы остальные DM не видели команды).

## Как устроены подсистемы

### Сообщения и retention

Бот сохраняет текст и подписи участников (имя, время, `chat_id`, `message_id`, `message_thread_id`). Также пишет в Postgres текст/подписи своих ответов на @упоминания и автоответы (чтобы следующий контекст их видел; изображения не хранятся). Саммари, стихи, GIF, новости и служебные сообщения в историю контекста не попадают. Команды и чужие боты из выборки исключаются. Фоновая очистка — каждые `RETENTION_CLEANUP_INTERVAL_MS`, срок сообщений `RETENTION_DAYS`, записей usage — `USAGE_RETENTION_DAYS`, служебных claim’ов саммари — `SUMMARY_REQUEST_RETENTION_DAYS`.

### Саммари и `/verse`

Выборка по числу сообщений или периоду, укладка в JSON-бюджет `MAX_INPUT_CHARS`, ответ до `MAX_OUTPUT_TOKENS`. Уровень сарказма (`SUMMARY_SARCASM_PERCENT` / `/settings`) и тон ответа влияют на промпт. Память чата, если она есть, передаётся в сообщении пользователя как недоверенный фон: саммари строится по выбранным сообщениям и не должно выдумывать события из памяти. Кулдаун группы — `SUMMARY_COOLDOWN_SECONDS` (по умолчанию **10**). Неуспешный запрос тоже занимает кулдаун. Повторные запросы оплачиваются заново.

### `/gif`

По выборке сообщений модель предлагает поисковый запрос → Giphy → случайная анимация в чат. Без `GIPHY_API_KEY` команда недоступна. Лимиты: `GIF_*`, кулдаун `GIF_COOLDOWN_SECONDS`.

### @упоминания

Глобальный gate `MENTION_ENABLED` + переключатель в `/settings`. Срабатывает на @бота / `text_mention` / reply на сообщение бота. Промпт собирается из отдельных блоков со своими бюджетами: текст запроса (`MENTION_MAX_INPUT_CHARS` режет только запрос, не весь промпт), цитата (`MENTION_QUOTE_MAX_CHARS`), цепочка ответов к цитате (`MENTION_THREAD_*`), короткое окно рядом со старой цитатой (`MENTION_AROUND_QUOTE_*`) и более широкое окно недавних сообщений перед обращением (`MENTION_CONTEXT_*`, по умолчанию 40 сообщений / 45 минут / 4000 символов). Контекст не урезает запрос и цитату. Ночная память и закреплённые факты попадают в сообщение пользователя как недоверенный фон, не в системный промпт. Цитата из другого чата (например, пост связанного канала) в выборку по id не берётся. До `MENTION_MAX_INPUT_IMAGES` картинок (vision, `MENTION_VISION_*`, размер `MENTION_MAX_INPUT_IMAGE_MB`). Ответ может содержать до `MENTION_MAX_IMAGES` сгенерированных картинок (`OPENAI_IMAGE_MODEL`); ключевые слова вроде «мем»/«демотиватор» включают meme-режим. При `MENTION_WEB_SEARCH=true` обычные текстовые ответы идут через Responses API + hosted `web_search` (`tool_choice` auto — поиск не обязателен; размер контекста поиска — `NEWS_SEARCH_CONTEXT_SIZE`; для `gpt-6*` reasoning effort `medium`; нужен `/v1/responses` + `web_search`); входные фото по-прежнему передаются в модель (vision). Мемы и явные запросы на генерацию картинок («нарисуй…», `generate image`, …) остаются на Chat Completions с `attach_image` и `reasoning_effort=none` у `gpt-6*`. `MENTION_WEB_SEARCH=false` — Completions для всех упоминаний без веба. Кулдаун `MENTION_COOLDOWN_SECONDS`.

### Автоответ на вопросы без ответа

Глобальный `AUTO_ANSWER_ENABLED` + **opt-in в `/settings`** (по умолчанию выкл). Общий вопрос без reply/упоминаний/команд/ссылок на медиа ставится в очередь; если за `AUTO_ANSWER_DELAY_SECONDS` (~5 мин) люди не отреагировали, планировщик всегда отвечает через Responses API — даже когда `MENTION_WEB_SEARCH=false`, поэтому прокси должен отдавать `/v1/responses`. Веб-поиск включается только при `MENTION_WEB_SEARCH=true` (инструмент есть, `tool_choice` не задаётся). Для `gpt-6*` reasoning effort `medium`. Окно контекста — `AUTO_ANSWER_CONTEXT_*` (по умолчанию 30 сообщений / 45 минут / 4000 символов). Текст вопроса по-прежнему режется отдельно до `AUTO_ANSWER_MAX_INPUT_CHARS` (1500) и не делит этот лимит с контекстом. Автоответ не ставится на реплаи, поэтому ветка обычно пустая; если у сохранённого вопроса всё же есть `reply_to_message_id`, перед вопросом добавляется блок «Ветка обсуждения» (`MENTION_THREAD_*`). Память чата передаётся в сообщение пользователя как недоверенный фон. Для `gpt-6*` лимит `AUTO_ANSWER_MAX_OUTPUT_TOKENS` включает токены рассуждения. Любая активность людей и редактирование вопроса отменяют ожидание. Claim lease: `AUTO_ANSWER_CLAIM_LEASE_MS`.

### Память чата

Таблица `chat_memory` (миграция `003_chat_memory.sql`): `body` — короткая заметка модели, `pinned` — факты, которые задал администратор, плюс `updated_at`, `source_until`, `last_run_on`, `claimed_until`. Планировщик тикает каждые `CHAT_MEMORY_TICK_INTERVAL_MS` и обновляет `body` только в час `CHAT_MEMORY_HOUR_MOSCOW` (по умолчанию 3:00 Europe/Moscow), не чаще одного раза за московские сутки. В промпт попадают сообщения за `CHAT_MEMORY_LOOKBACK_HOURS` (включая ответы бота). Lease как у новостей: `OPENAI_TIMEOUT_MS × (1 + OPENAI_MAX_RETRIES) + 60 с`, минимум 3 минуты. Если за окно не было сообщений людей, день помечается выполненным, а `body` и `pinned` не стираются. Пустой ответ модели не записывается и не закрывает день: lease остаётся до истечения. Модель — `OPENAI_CHAT_MEMORY_MODEL` или `OPENAI_MODEL` (Chat Completions, без инструментов; у `gpt-6*` `reasoning_effort=none`). Расход пишется в `openai_usage` с kind `chat_memory`; отдельного счётчика нет, `/usage` суммирует все токены. Непустой `ALLOWED_CHAT_IDS` оставляет только эти чаты и не проставляет `last_run_on` отфильтрованным. `/memory`, `/remember` и `/forget` доступны администраторам, даже если `CHAT_MEMORY_ENABLED=false`. Закреплённые факты и заметка уходят в сообщение пользователя у упоминаний, автоответов и саммари как недоверенный фон. Владелец в личке может запустить `/memory_refresh`: выбрать группу и пересчитать `body` по сообщениям за последние 3 суток (72 часа), в любой час и даже если ночной проход сегодня уже был. Закреплённые факты эта команда не меняет. Если за 3 дня не было сообщений людей, заметка остаётся как была и день для ночного прохода не закрывается. Пока `CHAT_MEMORY_ENABLED=false`, команда не стартует. Chat GC удаляет строку вместе с остальными данными недоступного чата. В `messages` хранится `reply_to_message_id`.

### Ежедневные новости

Глобальный `NEWS_ENABLED` + включение и сферы в `/settings`. Случайное время в окне 10:00–21:00 Europe/Moscow. По умолчанию Responses API + hosted `web_search` (`NEWS_WEB_SEARCH=true`); `false` — откат на Chat Completions без веба. Модель: `OPENAI_NEWS_MODEL` или `OPENAI_MODEL`. Планировщик тикает каждые `NEWS_TICK_INTERVAL_MS`; мягкий retry — `NEWS_RETRY_MINUTES`. Lease claim масштабируется от `OPENAI_TIMEOUT_MS × (1 + OPENAI_MAX_RETRIES) + 60s` (минимум 3 мин), чтобы не было двойной отправки.

### Очистка недоступных чатов (chat GC)

Глобальный `CHAT_GC_ENABLED`. Планировщик тикает каждые `CHAT_GC_TICK_INTERVAL_MS`, но реально работает только в часы МСК из `CHAT_GC_HOURS_MOSCOW` (по умолчанию `4,16` ≈ 2 раза в сутки). GC зондирует **все** известные групповые `chat_id` (отрицательные) и **игнорирует** `ALLOWED_CHAT_IDS` (allowlist — только gate для действий вроде новостей, не для очистки сирот); положительные private id не зондируются и не чистятся. Для каждого id вызывается `getChat`, и если он успешен — ещё `getChatMemberCount`. Удалённая обычная группа часто всё ещё отвечает на `getChat`; число участников у неё уже не отдаётся (`the group chat was deleted`). Постоянная ошибка Telegram (403 / chat not found / kicked / not a member / deactivated / group chat was deleted / peer_id_invalid) удаляет связанные строки в БД. Upgrade group→supergroup **чистит старый id** (сообщество живёт под новым id как отдельный чат; remap истории нет). `video_cache` не трогается. При 429 или ошибке purge слот не помечается выполненным (повтор на следующем тике). Пауза между зондами: `CHAT_GC_PROBE_DELAY_MS`. Владелец в личке запускает ту же проверку командой `/check_chats` в любой час: сначала подтверждение, затем итог (сколько групп на месте, какие id удалены). Успешный ручной проход закрывает слот текущего часа МСК, чтобы планировщик не повторил его сразу. Пока `CHAT_GC_ENABLED=false`, команда не стартует.

### Видео

Отдельное сообщение **только** со ссылкой на YouTube Shorts / TikTok / Instagram Reels / VK Клипы → yt-dlp + ffmpeg → MP4 без подписи. Кэш `file_id` в Postgres (`VIDEO_CACHE_SIZE`). Лимиты `VIDEO_*`. Общая media-очередь: см. ниже.

### Галереи

Отдельная ссылка на пост Instagram / X / Reddit / Pixiv / Imgur → gallery-dl → фото или альбом с подписью-метаданными. Whitelist: `GALLERY_WHITELIST`. Для Instagram hang-timeout: `INSTAGRAM_DOWNLOAD_TIMEOUT_MS`.

### Marketplace (Wildberries)

При `MARKETPLACE_ENABLED` ссылка на товар WB обрабатывается как галерея: до `MARKETPLACE_MAX_IMAGES` фото + название. Ozon/Яндекс.Маркет не поддерживаются.

### Очереди `ai-jobs` / `media-jobs`

- **AI** (`core/ai-jobs`): до 3 параллельных фоновых запросов, не больше одного на чат (`/summary`, `/verse`, `/gif`, mentions). При занятости — «попробуйте позже»; входящие сообщения продолжают сохраняться.
- **Media** (`core/media-jobs`): общий пул видео+картинок; параллелизм `MEDIA_MAX_CONCURRENT` или fallback `VIDEO_MAX_CONCURRENT`; кулдаун чата `MEDIA_COOLDOWN_SECONDS` или fallback `VIDEO_COOLDOWN_SECONDS` (и/или значение из `/settings`). Очереди отложенных заданий нет. При shutdown активные задачи прерываются/дожидаются.

### `/settings`

Inline-меню только для админов: саммари только админам, число сообщений, сарказм, тон (джентльмен / пацанчик / дерзкий), mentions, автоответ, видео/картинки, пауза медиа, новости и сферы, сброс. Сброс чистит настройки чата и отменяет pending автоответы.

### `/usage`, `/stats` и `/costs`

`/usage` в группе — сколько токенов потрачено за текущий месяц (МСК).

`/stats` в личке владельца — рост за текущий календарный месяц Europe/Moscow (новые чаты с первым usage и прирост участников по снимкам `chat_member_snapshots`) и список чатов: название (`id`), число участников, сумма prompt+completion токенов за срок хранения usage. Без оценки $.

`/costs` в личке владельца — сумма из Admin API `GET /v1/organization/costs` и токены completions из `GET /v1/organization/usage/completions` за текущий календарный месяц Europe/Moscow (MTD). Нужен отдельный `OPENAI_ADMIN_API_KEY` (не `OPENAI_API_KEY`); `OPENAI_BASE_URL` для этих запросов не используется.

## Полный каталог конфигурации

Значения по умолчанию синхронизированы с `src/config.ts` / `.env.example`.

### Обязательное и доступ

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Токен Bot API |
| `OPENAI_API_KEY` | — | Ключ OpenAI |
| `POSTGRES_PASSWORD` | — | Пароль Postgres в Compose |
| `ALLOWED_CHAT_IDS` | пусто | CSV отрицательных group id; пусто — все группы (только для доверенного использования) |
| `OWNER_USER_ID` | пусто | Telegram user id владельца для `/stats`, `/costs`, `/memory_refresh` и `/check_chats` |
| `SUMMARY_ADMIN_ONLY` | `true` | Дефолт «саммари только админам» для новых чатов |

### OpenAI

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `OPENAI_ADMIN_API_KEY` | пусто | Admin API key для owner `/costs` (биллинг org); не путать с `OPENAI_API_KEY` |
| `OPENAI_MODEL` | `gpt-6-sol` | Основная модель. Автоответ идёт через Responses API, не Chat Completions. У `gpt-6*` Chat Completions по-прежнему `reasoning_effort=none` (саммари, gif, мемы, генерация картинок, слияние памяти) |
| `OPENAI_NEWS_MODEL` | пусто | Модель новостей; пусто → `OPENAI_MODEL` |
| `OPENAI_CHAT_MEMORY_MODEL` | пусто | Модель ночной памяти (Chat Completions); пусто → `OPENAI_MODEL` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1-mini` | Генерация картинок в @упоминаниях |
| `OPENAI_BASE_URL` | пусто | Совместимый endpoint; для mentions/news с вебом нужен `/v1/responses` + `web_search` |
| `OPENAI_TIMEOUT_MS` | `90000` | Таймаут SDK; для mentions/news web_search часто `120000+` |
| `OPENAI_MAX_RETRIES` | `1` | Повторы SDK |
| `OPENAI_INPUT_USD_PER_1M_TOKENS` | `2` | Оценка $ input для записи usage (не биллинг) |
| `OPENAI_OUTPUT_USD_PER_1M_TOKENS` | `10` | Оценка $ output для записи usage |
| `OPENAI_IMAGE_USD` | `0.011` | Оценка $ за одну картинку для записи usage |

### Postgres

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `DATABASE_URL` | пусто | Локальный/dev URL; в Docker обычно не нужен |
| `POSTGRES_USER` / `POSTGRES_DB` | `bot` / `telegram_bot` | Compose |
| `PG_POOL_MAX` | `10` | Размер пула |
| `PG_CONNECTION_TIMEOUT_MS` | `10000` | Таймаут коннекта |
| `PG_IDLE_TIMEOUT_MS` | `30000` | Idle в пуле |
| `PG_STATEMENT_TIMEOUT_MS` | `15000` | Statement timeout |

### Саммари / Telegram text limits

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `DEFAULT_MESSAGE_COUNT` | `100` | N без аргумента в `/summary` |
| `MAX_MESSAGE_COUNT` | `1000` | Потолок выборки |
| `MAX_INPUT_CHARS` | `60000` | Бюджет JSON переписки |
| `MAX_OUTPUT_TOKENS` | `1500` | Лимит ответа саммари |
| `SUMMARY_COOLDOWN_SECONDS` | `10` | Пауза между саммари/verse в группе |
| `SUMMARY_REQUEST_RETENTION_DAYS` | `2` | Хранение служебных claim’ов саммари |
| `SUMMARY_SARCASM_PERCENT` | `0` | Стартовый сарказм (0–100) |
| `TELEGRAM_MAX_MESSAGE_LENGTH` | `4000` | Нарезка длинных ответов |
| `TELEGRAM_MAX_CAPTION_LENGTH` | `1024` | Нарезка подписей |

### GIF

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `GIF_ENABLED` | `true` | Глобальный gate `/gif` |
| `GIPHY_API_KEY` | пусто | Ключ [Giphy](https://developers.giphy.com/) |
| `GIF_DEFAULT_MESSAGE_COUNT` | `40` | Сообщений по умолчанию |
| `GIF_MAX_MESSAGE_COUNT` | `80` | Потолок |
| `GIF_MAX_INPUT_CHARS` | `12000` | Бюджет входа |
| `GIF_COOLDOWN_SECONDS` | `10` | Пауза между `/gif` |

### @упоминания

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `MENTION_ENABLED` | `true` | Глобальный gate |
| `MENTION_MAX_INPUT_CHARS` | `1500` | Потолок только текста запроса, не всего промпта |
| `MENTION_MAX_OUTPUT_TOKENS` | `2500` | Лимит ответа на Responses, включая токены рассуждения `gpt-6*` |
| `MENTION_COOLDOWN_SECONDS` | `10` | Пауза |
| `MENTION_IMAGES_ENABLED` | `true` | Генерация картинок в ответе |
| `MENTION_MAX_IMAGES` | `2` | Макс. картинок в ответе (0–4) |
| `MENTION_VISION_ENABLED` | `true` | Разбор входных фото |
| `MENTION_MAX_INPUT_IMAGES` | `4` | Сколько входных фото брать |
| `MENTION_MAX_INPUT_IMAGE_MB` | `5` | Потолок размера входного фото |
| `MENTION_CONTEXT_MAX_MESSAGES` | `40` | Недавнее окно перед обращением (`0` выключает только его) |
| `MENTION_CONTEXT_LOOKBACK_MINUTES` | `45` | Глубина недавнего окна |
| `MENTION_CONTEXT_MAX_CHARS` | `4000` | Бюджет только недавнего окна |
| `MENTION_QUOTE_MAX_CHARS` | `1500` | Бюджет текста цитаты |
| `MENTION_THREAD_MAX_MESSAGES` | `8` | Длина цепочки ответов к цитате (`0` выключает запрос) |
| `MENTION_THREAD_MAX_CHARS` | `2000` | Бюджет цепочки |
| `MENTION_AROUND_QUOTE_MAX_MESSAGES` | `6` | Короткое окно перед цитатой (`0` выключает запрос) |
| `MENTION_AROUND_QUOTE_LOOKBACK_MINUTES` | `10` | Глубина окна рядом с цитатой |
| `MENTION_AROUND_QUOTE_MAX_CHARS` | `1200` | Бюджет окна рядом с цитатой |
| `MENTION_WEB_SEARCH` | `true` | Responses + `web_search` (auto; `gpt-6*` reasoning `medium`; мемы и явный image-gen — Completions с `reasoning_effort=none`) |

### Автоответ

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `AUTO_ANSWER_ENABLED` | `true` | Глобальный gate (в чате всё равно opt-in) |
| `AUTO_ANSWER_DELAY_SECONDS` | `300` | Ждать людей перед ответом |
| `AUTO_ANSWER_TICK_INTERVAL_MS` | `15000` | Тик планировщика |
| `AUTO_ANSWER_MAX_OUTPUT_TOKENS` | `2500` | Лимит ответа на Responses, включая токены рассуждения `gpt-6*` |
| `AUTO_ANSWER_MAX_INPUT_CHARS` | `1500` | Бюджет вопроса |
| `AUTO_ANSWER_CLAIM_LEASE_MS` | `180000` | Lease claim’а |
| `AUTO_ANSWER_CONTEXT_MAX_MESSAGES` | `30` | Контекст до вопроса |
| `AUTO_ANSWER_CONTEXT_LOOKBACK_MINUTES` | `45` | Окно по времени |
| `AUTO_ANSWER_CONTEXT_MAX_CHARS` | `4000` | Бюджет символов контекста (вопрос режется отдельно) |

### Новости

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `NEWS_ENABLED` | `true` | Глобальный gate |
| `NEWS_MAX_OUTPUT_TOKENS` | `700` | Лимит текста |
| `NEWS_TICK_INTERVAL_MS` | `60000` | Тик планировщика |
| `NEWS_RETRY_MINUTES` | `20` | Мягкий retry |
| `NEWS_WEB_SEARCH` | `true` | Responses + `web_search` |
| `NEWS_SEARCH_CONTEXT_SIZE` | `medium` | `low` / `medium` / `high` |
| `NEWS_FORCE_WEB_SEARCH` | `true` | `tool_choice: required` |

### Память чата

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `CHAT_MEMORY_ENABLED` | `true` | Ночной merge; `/remember` работает и при `false` |
| `CHAT_MEMORY_TICK_INTERVAL_MS` | `60000` | Тик планировщика |
| `CHAT_MEMORY_HOUR_MOSCOW` | `3` | Час Europe/Moscow, когда merge может идти |
| `CHAT_MEMORY_LOOKBACK_HOURS` | `24` | Окно сообщений для merge |
| `CHAT_MEMORY_MAX_MESSAGES` | `400` | Сколько сообщений брать |
| `CHAT_MEMORY_MAX_INPUT_CHARS` | `12000` | Бюджет пользовательского промпта merge, включая заголовки |
| `CHAT_MEMORY_MAX_OUTPUT_TOKENS` | `700` | Лимит ответа модели |
| `CHAT_MEMORY_PROMPT_MAX_CHARS` | `2000` | Сколько текста `body` класть в другие промпты |
| `CHAT_MEMORY_PIN_MAX_CHARS` | `1500` | Потолок закреплённых фактов |

### Очистка чатов (chat GC)

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `CHAT_GC_ENABLED` | `true` | Глобальный gate |
| `CHAT_GC_TICK_INTERVAL_MS` | `3600000` | Интервал тика планировщика |
| `CHAT_GC_HOURS_MOSCOW` | `4,16` | Часы МСК, когда GC может бежать |
| `CHAT_GC_PROBE_DELAY_MS` | `75` | Пауза между `getChat` |

### Media / process / downloaders

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `MEDIA_URL_MAX_LENGTH` | `512` | Макс. длина распознаваемой URL |
| `PROCESS_MAX_STDOUT_BYTES` | `4194304` | Потолок stdout дочернего процесса |
| `DOWNLOADER_HTTP_TIMEOUT_SECONDS` | `15` | HTTP-таймаут yt-dlp/gallery-dl |
| `DOWNLOADER_RETRIES` | `1` | Ретраи загрузчика |
| `MEDIA_MAX_CONCURRENT` | unset → `VIDEO_MAX_CONCURRENT` | Общий параллелизм media |
| `MEDIA_COOLDOWN_SECONDS` | unset → `VIDEO_COOLDOWN_SECONDS` (и дефолт чата) | Пауза между media в группе |

### Видео

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `VIDEO_ENABLED` | `true` | Глобальный gate |
| `VIDEO_MAX_SIZE_MB` | `45` | Макс. файл (≤ лимита Bot API) |
| `VIDEO_MAX_DURATION_SECONDS` | `180` | Макс. длительность |
| `VIDEO_TIMEOUT_SECONDS` | `180` | Таймаут всей обработки |
| `VIDEO_COOLDOWN_SECONDS` | `10` | Fallback-пауза media |
| `VIDEO_MAX_CONCURRENT` | `1` | Fallback параллелизма media (1–3) |
| `VIDEO_MAX_HEIGHT` | `1080` | Макс. высота после ffmpeg |
| `VIDEO_FFMPEG_THREADS` | `2` | Потоки ffmpeg |
| `VIDEO_FFMPEG_PRESET` | `faster` | Preset |
| `VIDEO_FFMPEG_CRF` | `23` | CRF |
| `VIDEO_AUDIO_BITRATE` | `192k` | Аудио |
| `VIDEO_EXTRACTORS` | `youtube.*,tiktok.*,vm.tiktok.*,instagram.*,vk.*` | Разрешённые extractors yt-dlp |
| `VIDEO_CACHE_SIZE` | `1000` | Кэш `file_id` (0 = выкл) |

### Галерея и marketplace

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `GALLERY_ENABLED` | `true` | Глобальный gate картинок |
| `GALLERY_MAX_IMAGES` | `10` | Макс. фото в альбоме (1–10) |
| `GALLERY_MAX_IMAGE_MB` | `15` | Макс. исходный файл |
| `GALLERY_MAX_TOTAL_MB` | `80` | Лимит временных файлов |
| `GALLERY_TIMEOUT_SECONDS` | `180` | Таймаут |
| `GALLERY_DISK_CHECK_INTERVAL_MS` | `500` | Интервал проверки объёма |
| `GALLERY_MAX_DIMENSION` | `1920` | Макс. сторона JPEG |
| `GALLERY_OUTPUT_MAX_MB` | `10` | Макс. размер JPEG для Telegram |
| `GALLERY_METADATA_MAX_MB` | `4` | Бюджет метаданных загрузчика |
| `GALLERY_WHITELIST` | `instagram,twitter,reddit,pixiv,imgur` | Платформы gallery-dl |
| `INSTAGRAM_DOWNLOAD_TIMEOUT_MS` | `120000` | Защита от зависания Instagram |
| `MARKETPLACE_ENABLED` | `true` | Wildberries-карточки |
| `MARKETPLACE_MAX_IMAGES` | `5` | Макс. фото товара |

### Retention / usage

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `RETENTION_DAYS` | `30` | Хранение сообщений |
| `RETENTION_CLEANUP_INTERVAL_MS` | `3600000` | Интервал очистки |
| `USAGE_RETENTION_DAYS` | `90` | Хранение строк OpenAI usage |

## Данные и ограничения Telegram

- Сохраняются текст/подписи участников и исходящих ответов бота на mentions/автоответы, а также `reply_to_message_id`. Раз в сутки может сохраняться короткое описание чата и закреплённые факты администратора; они уходят в OpenAI вместе с упоминаниями, автоответами и саммари. Файлы/фото/аудио/видео не анализируются (кроме явной vision-логики mentions и media-репостов). Память и факты удаляются вместе с данными чата, если чат недоступен.
- История до добавления бота недоступна. Telegram не гарантирует доставку updates при простое &gt; 24 ч.
- Редактирование обновляет текст, если пришёл update. Удаления в обычных группах Bot API не шлёт — удалённый текст может остаться до expiry.
- Модель получает выбранные сообщения и имена; политики OpenAI независимы от `RETENTION_DAYS`.
- Ответы модели могут ошибаться — сверяйте важное с перепиской.
- Текст сообщений, API-ключи и сырые ошибки SDK в логи не пишутся.

Удаление истории одной группы:

```bash
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

```sql
DELETE FROM messages WHERE chat_id = -1001234567890;
```

Остановка: `docker compose down` (данные сохраняются). **`docker compose down -v` удаляет всю базу безвозвратно.**

Видео/галереи: сервисы могут блокировать IP, требовать логин или ломать extractors. Cookies бот не использует. Обновление инструментов: `docker compose build --no-cache bot && docker compose up -d`. Можно закрепить версии: `--build-arg YT_DLP_VERSION=…` / `GALLERY_DL_VERSION=…`.

Smoke media внутри образа (без соцсетей):

```bash
docker build -t telegram-ai-bot:test .
docker run --rm -v "$PWD/test:/tests:ro" --entrypoint sh telegram-ai-bot:test /tests/media-smoke.sh
```

## Локальная разработка и тесты

Нужны Node.js 22+ и Postgres. Вне Docker задайте `DATABASE_URL`. Для video/gallery локально нужны `yt-dlp`, `ffmpeg`/`ffprobe`, `gallery-dl` в `PATH`.

```bash
npm ci
npm run dev
```

Проверки:

```bash
npm run check
npm test
npm run build
```

Интеграция БД: `npm run test:integration` (отдельная тестовая `DATABASE_URL`, непустые тестовые `TELEGRAM_BOT_TOKEN` / `OPENAI_API_KEY`; внешние API не вызываются). Скрипт трогает chat id `-987654321001` и `-987654321002`.

CI гоняет unit-тесты, Postgres integration и сборку образа. Живые Telegram/OpenAI проверки — только с вашими ключами и оплаченным балансом.

Планировщики (новости, память чата, автоответ, chat GC) не запускают перекрывающиеся тики в одном процессе. При штатной остановке бот дожидается начатых AI/media задач перед закрытием пула БД.

import 'dotenv/config';
import { z } from 'zod';

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const bool = z.enum(['true', 'false']);

const schema = z.object({
  /** Telegram Bot API token from @BotFather. */
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  /** OpenAI API key. */
  OPENAI_API_KEY: z.string().min(1),
  /**
   * Optional OpenAI Admin API key for owner `/costs` (org billing).
   * Do not reuse OPENAI_API_KEY — Admin keys are separate.
   */
  OPENAI_ADMIN_API_KEY: z.string().default(''),
  /** Default Chat Completions model (summary, mention, gif, auto-answer, …). For gpt-6* sets reasoning_effort=none. */
  OPENAI_MODEL: z.string().min(1).default('gpt-6-sol'),
  /** Optional OpenAI-compatible base URL; empty = official API. News+web_search needs /v1/responses + hosted web_search. */
  OPENAI_BASE_URL: z.string().default(''),
  /** OpenAI SDK request timeout (ms). Raise for news with web_search. */
  OPENAI_TIMEOUT_MS: integer(90000, 1000, 600000),
  /** OpenAI SDK max retries per request. */
  OPENAI_MAX_RETRIES: integer(1, 0, 5),
  /** Postgres URL for local/dev; empty → node-pg uses PGHOST/PGUSER/PGPASSWORD/PGDATABASE (Docker Compose). */
  DATABASE_URL: z.string().default(''),
  /** Max connections in the pg pool. */
  PG_POOL_MAX: integer(10, 1, 100),
  /** Time to wait for a new DB connection (ms). */
  PG_CONNECTION_TIMEOUT_MS: integer(10000, 1000, 120000),
  /** Idle client lifetime in the pool (ms). */
  PG_IDLE_TIMEOUT_MS: integer(30000, 1000, 600000),
  /** Per-statement timeout for normal queries (ms); migrate() raises this temporarily for DDL. */
  PG_STATEMENT_TIMEOUT_MS: integer(15000, 1000, 300000),
  /** Comma-separated allowed group ids (negative); empty = all groups (trusted use only). */
  ALLOWED_CHAT_IDS: z.string().default('').refine(
    (value) => !value.trim() || value.split(',').every((id) => /^-\d+$/.test(id.trim())),
    'Expected comma-separated negative Telegram group IDs',
  ),
  /** Owner Telegram user id; private /stats, /costs, /personalize work only for this account. */
  OWNER_USER_ID: z.string().default('').refine(
    (value) => !value.trim() || /^\d+$/.test(value.trim()),
    'Expected numeric Telegram user id',
  ),
  /** Default for new chats: /summary /verse /gif only for admins. */
  SUMMARY_ADMIN_ONLY: bool.default('true'),
  /** Default N for /summary when no argument is given (also seeds chat_settings). */
  DEFAULT_MESSAGE_COUNT: integer(100, 1, 10000),
  /** Hard cap on messages selected for summary/verse/gif (count or period). */
  MAX_MESSAGE_COUNT: integer(1000, 1, 10000),
  /** Max characters of conversation JSON sent to the model for /summary|/verse. */
  MAX_INPUT_CHARS: integer(60000, 1000, 500000),
  /** Max completion tokens for summary/verse replies. */
  MAX_OUTPUT_TOKENS: integer(1500, 256, 10000),
  /** Minimum seconds between /summary|/verse claims in the same chat. */
  SUMMARY_COOLDOWN_SECONDS: integer(10, 1, 86400),
  /** How long summary_requests claim rows are kept before cleanup. */
  SUMMARY_REQUEST_RETENTION_DAYS: integer(2, 1, 365),
  /** Default sarcasm level 0–100 for new chats (overridable in /settings). */
  SUMMARY_SARCASM_PERCENT: integer(0, 0, 100),
  /** Global gate for /gif (still needs GIPHY_API_KEY). */
  GIF_ENABLED: bool.default('true'),
  /** Giphy API key; empty disables /gif even if GIF_ENABLED. */
  GIPHY_API_KEY: z.string().default(''),
  /** Default message window for /gif without args. */
  GIF_DEFAULT_MESSAGE_COUNT: integer(40, 1, 10000),
  /** Max messages selectable for /gif. */
  GIF_MAX_MESSAGE_COUNT: integer(80, 1, 10000),
  /** Max characters of conversation JSON for GIF reaction prompts. */
  GIF_MAX_INPUT_CHARS: integer(12000, 1000, 100000),
  /** Minimum seconds between /gif requests in the same chat. */
  GIF_COOLDOWN_SECONDS: integer(10, 1, 3600),
  /** Soft cap when splitting long bot text replies (Telegram limit is 4096). */
  TELEGRAM_MAX_MESSAGE_LENGTH: integer(4000, 1000, 4096),
  /** Soft cap for photo/GIF captions when splitting. */
  TELEGRAM_MAX_CAPTION_LENGTH: integer(1024, 100, 1024),
  /** Max length of a standalone URL that triggers video/gallery/marketplace. */
  MEDIA_URL_MAX_LENGTH: integer(512, 64, 2048),
  /** Abort child process if captured stdout exceeds this many bytes (stderr is only tailed for diagnostics). */
  PROCESS_MAX_STDOUT_BYTES: integer(4 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
  /** HTTP timeout passed to yt-dlp / gallery-dl. */
  DOWNLOADER_HTTP_TIMEOUT_SECONDS: integer(15, 1, 120),
  /** Retry count passed to yt-dlp / gallery-dl. */
  DOWNLOADER_RETRIES: integer(1, 0, 10),
  /** Default for new chats: auto-download image posts (gallery-dl / marketplace). */
  GALLERY_ENABLED: bool.default('true'),
  /** Max images to download/send from one post (Telegram album limit 10). */
  GALLERY_MAX_IMAGES: integer(10, 1, 10),
  /** Max size of a single source image before processing (MB). */
  GALLERY_MAX_IMAGE_MB: integer(15, 1, 30),
  /** Max total size of temp download files for one gallery job (MB). */
  GALLERY_MAX_TOTAL_MB: integer(80, 1, 150),
  /** Overall timeout for gallery download + process + send (seconds). */
  GALLERY_TIMEOUT_SECONDS: integer(180, 10, 600),
  /** How often to re-check temp disk usage during gallery download (ms). */
  GALLERY_DISK_CHECK_INTERVAL_MS: integer(500, 100, 10000),
  /** Max JPEG side length after resize for Telegram. */
  GALLERY_MAX_DIMENSION: integer(1920, 320, 4096),
  /** Max size of an output JPEG sent to Telegram (MB). */
  GALLERY_OUTPUT_MAX_MB: integer(10, 1, 20),
  /** Max size of gallery-dl metadata JSON accepted (MB). */
  GALLERY_METADATA_MAX_MB: integer(4, 1, 32),
  /** Comma-separated gallery-dl site whitelist. */
  GALLERY_WHITELIST: z.string().min(1).default('instagram,twitter,reddit,pixiv,imgur'),
  /** Extra timeout for Instagram gallery-dl downloads (hang prevention). */
  INSTAGRAM_DOWNLOAD_TIMEOUT_MS: integer(120000, 10000, 300000),
  /** Allow Wildberries product links in the gallery pipeline. */
  MARKETPLACE_ENABLED: bool.default('true'),
  /** Max product photos from a marketplace card (capped by GALLERY_MAX_IMAGES). */
  MARKETPLACE_MAX_IMAGES: integer(5, 1, 10),
  /** Shared video+gallery concurrency; unset → VIDEO_MAX_CONCURRENT. */
  MEDIA_MAX_CONCURRENT: z.coerce.number().int().min(1).max(3).optional(),
  /** Shared per-chat media cooldown (seconds); unset → VIDEO_COOLDOWN_SECONDS (also seeds chat_settings). */
  MEDIA_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(3600).optional(),
  /** Default for new chats: auto-download short videos (yt-dlp). */
  VIDEO_ENABLED: bool.default('true'),
  /** Max downloaded/re-encoded video file size (MB); must stay ≤ Bot API cloud limit. */
  VIDEO_MAX_SIZE_MB: integer(45, 1, 45),
  /** Max source video duration (seconds). */
  VIDEO_MAX_DURATION_SECONDS: integer(180, 1, 600),
  /** Overall timeout for video download + ffmpeg + send (seconds). */
  VIDEO_TIMEOUT_SECONDS: integer(180, 10, 600),
  /** Fallback media cooldown when MEDIA_COOLDOWN_SECONDS is unset. */
  VIDEO_COOLDOWN_SECONDS: integer(10, 1, 3600),
  /** Fallback media concurrency when MEDIA_MAX_CONCURRENT is unset (1–3). */
  VIDEO_MAX_CONCURRENT: integer(1, 1, 3),
  /** Max video height after ffmpeg scale (long side). */
  VIDEO_MAX_HEIGHT: integer(1080, 240, 2160),
  /** ffmpeg -threads for H.264 encode. */
  VIDEO_FFMPEG_THREADS: integer(2, 1, 16),
  /** ffmpeg -preset for H.264 encode. */
  VIDEO_FFMPEG_PRESET: z.string().min(1).default('faster'),
  /** ffmpeg -crf quality (lower = larger/better). */
  VIDEO_FFMPEG_CRF: integer(23, 0, 51),
  /** ffmpeg AAC audio bitrate (e.g. 192k). */
  VIDEO_AUDIO_BITRATE: z.string().min(1).default('192k'),
  /** yt-dlp --use-extractors allow-list (comma-separated patterns). */
  VIDEO_EXTRACTORS: z.string().min(1).default('youtube.*,tiktok.*,vm.tiktok.*,instagram.*,vk.*'),
  /** How many Telegram file_id entries to keep in video_cache (0 = disable cache). */
  VIDEO_CACHE_SIZE: integer(1000, 0, 10000),
  /** Global gate for @mentions / reply-to-bot (per-chat can still disable). */
  MENTION_ENABLED: bool.default('true'),
  /** Max characters of mention request text (quote + user text + context budget). */
  MENTION_MAX_INPUT_CHARS: integer(1500, 100, 8000),
  /** Max completion tokens for mention text replies. */
  MENTION_MAX_OUTPUT_TOKENS: integer(600, 64, 4000),
  /** Minimum seconds between mention replies in the same chat. */
  MENTION_COOLDOWN_SECONDS: integer(10, 1, 3600),
  /** Allow the model to generate images/memes in mention replies. */
  MENTION_IMAGES_ENABLED: bool.default('true'),
  /** Max images the bot may generate in one mention reply (0–4). */
  MENTION_MAX_IMAGES: integer(2, 0, 4),
  /** Download and send user photos to the model (vision) on mention. */
  MENTION_VISION_ENABLED: bool.default('true'),
  /** Max input photos attached to a mention request. */
  MENTION_MAX_INPUT_IMAGES: integer(4, 0, 8),
  /** Max size of each input photo downloaded for vision (MB). */
  MENTION_MAX_INPUT_IMAGE_MB: integer(5, 1, 20),
  /** Preceding chat lines loaded before a mention; 0 = quote+request only. */
  MENTION_CONTEXT_MAX_MESSAGES: integer(6, 0, 100),
  /** How far back (minutes) to look for mention context messages. */
  MENTION_CONTEXT_LOOKBACK_MINUTES: integer(10, 1, 1440),
  /** Max characters of preceding context included in a mention prompt. */
  MENTION_CONTEXT_MAX_CHARS: integer(500, 0, 50000),
  /** Global gate for daily news scheduler (per-chat news still opt-in). */
  NEWS_ENABLED: bool.default('true'),
  /** Max tokens for a daily news post. */
  NEWS_MAX_OUTPUT_TOKENS: integer(700, 64, 4000),
  /** News scheduler poll interval (ms). */
  NEWS_TICK_INTERVAL_MS: integer(60000, 5000, 3600000),
  /** Soft retry delay after a failed news send (minutes). */
  NEWS_RETRY_MINUTES: integer(20, 1, 180),
  /** true = Responses API + hosted web_search; false = Chat Completions without web. */
  NEWS_WEB_SEARCH: bool.default('true'),
  /** Hosted web_search context size: low / medium / high. */
  NEWS_SEARCH_CONTEXT_SIZE: z.enum(['low', 'medium', 'high']).default('medium'),
  /** Force web_search tool call (tool_choice required) when NEWS_WEB_SEARCH is on. */
  NEWS_FORCE_WEB_SEARCH: bool.default('true'),
  /** Optional model for news only; empty → OPENAI_MODEL. */
  OPENAI_NEWS_MODEL: z.string().default(''),
  /** Global gate for unanswered-question auto-replies; per-chat setting stays opt-in (default off). */
  AUTO_ANSWER_ENABLED: bool.default('true'),
  /** Wait this many seconds for humans before the bot answers a question. */
  AUTO_ANSWER_DELAY_SECONDS: integer(300, 30, 3600),
  /** Auto-answer scheduler poll interval (ms). */
  AUTO_ANSWER_TICK_INTERVAL_MS: integer(15000, 1000, 600000),
  /** Max completion tokens for an auto-answer. */
  AUTO_ANSWER_MAX_OUTPUT_TOKENS: integer(600, 64, 4000),
  /** Max characters of the question text sent to the model. */
  AUTO_ANSWER_MAX_INPUT_CHARS: integer(1500, 100, 8000),
  /** How long a claimed auto-answer job is leased before another worker may reclaim it (ms). */
  AUTO_ANSWER_CLAIM_LEASE_MS: integer(180000, 10000, 600000),
  /** Preceding chat lines loaded when firing an auto-answer; 0 = question only. */
  AUTO_ANSWER_CONTEXT_MAX_MESSAGES: integer(12, 0, 100),
  /** How far back (minutes) to look for auto-answer context. */
  AUTO_ANSWER_CONTEXT_LOOKBACK_MINUTES: integer(15, 1, 1440),
  /** Max characters of preceding context for auto-answer prompts. */
  AUTO_ANSWER_CONTEXT_MAX_CHARS: integer(2500, 0, 50000),
  /** Global gate for participant personalization; per-chat defaults on. */
  PERSONALIZATION_ENABLED: bool.default('true'),
  /** Personalization scheduler poll interval (ms). */
  PERSONALIZATION_TICK_INTERVAL_MS: integer(60000, 5000, 3600000),
  /** Moscow hour (0–23) when the daily personalization job may run. */
  PERSONALIZATION_HOUR_MOSCOW: integer(3, 0, 23),
  /** How many hours of chat history to feed into personalization drafts. */
  PERSONALIZATION_LOOKBACK_HOURS: integer(24, 1, 168),
  /** Skip personalization if latest member count is >= this (strictly less required). */
  PERSONALIZATION_MAX_CHAT_MEMBERS: integer(20, 1, 10000),
  /** Max participants to update characteristics for per chat per run. */
  PERSONALIZATION_MAX_USERS_PER_CHAT: integer(30, 1, 200),
  /** Max messages loaded from DB for a personalization transcript. */
  PERSONALIZATION_MAX_MESSAGES: integer(500, 1, 5000),
  /** Max characters of transcript sent into personalization prompts. */
  PERSONALIZATION_MAX_INPUT_CHARS: integer(12000, 1000, 200000),
  /** Max tokens for merge / single-user personalization completions. */
  PERSONALIZATION_MAX_OUTPUT_TOKENS: integer(500, 64, 4000),
  /** Higher token budget for multi-user draft JSON; merge still uses PERSONALIZATION_MAX_OUTPUT_TOKENS. */
  PERSONALIZATION_DRAFT_MAX_OUTPUT_TOKENS: integer(1500, 64, 4000),
  /** Max characters of an existing characteristic injected into prompts. */
  PERSONALIZATION_PROMPT_MAX_CHARS: integer(3000, 100, 8000),
  /** How many users to draft in one OpenAI call. */
  PERSONALIZATION_BATCH_USERS: integer(10, 1, 50),
  /** Optional model for personalization drafts/merges; empty → OPENAI_MODEL. */
  OPENAI_PERSONALIZATION_MODEL: z.string().default(''),
  /** Image generation model for mention-produced pictures. */
  OPENAI_IMAGE_MODEL: z.string().min(1).default('gpt-image-1-mini'),
  /** Estimated USD per 1M input tokens for /stats and stored usage rows (not official billing). */
  OPENAI_INPUT_USD_PER_1M_TOKENS: z.coerce.number().min(0).max(1000).default(2),
  /** Estimated USD per 1M output tokens for /stats and stored usage rows. */
  OPENAI_OUTPUT_USD_PER_1M_TOKENS: z.coerce.number().min(0).max(1000).default(10),
  /** Estimated USD per generated image for /stats and stored usage rows. */
  OPENAI_IMAGE_USD: z.coerce.number().min(0).max(10).default(0.011),
  /** Retention for openai_usage rows and chat_member_snapshots (days). */
  USAGE_RETENTION_DAYS: integer(90, 1, 3650),
  /** Retention for stored chat messages and finished auto-answer rows (days). */
  RETENTION_DAYS: integer(30, 1, 3650),
  /** How often the retention cleanup job runs (ms). */
  RETENTION_CLEANUP_INTERVAL_MS: integer(3600000, 60000, 86400000),
});

export const config = schema.parse(process.env);
if (config.DEFAULT_MESSAGE_COUNT > config.MAX_MESSAGE_COUNT) {
  throw new Error('DEFAULT_MESSAGE_COUNT must not exceed MAX_MESSAGE_COUNT');
}
if (config.GIF_DEFAULT_MESSAGE_COUNT > config.GIF_MAX_MESSAGE_COUNT) {
  throw new Error('GIF_DEFAULT_MESSAGE_COUNT must not exceed GIF_MAX_MESSAGE_COUNT');
}
/** Parsed ALLOWED_CHAT_IDS; empty set means all groups are allowed. */
export const allowedChatIds = new Set(
  config.ALLOWED_CHAT_IDS.split(',').map((id) => id.trim()).filter(Boolean),
);
/** Parsed OWNER_USER_ID, or undefined if unset. */
export const ownerUserId = config.OWNER_USER_ID.trim()
  ? Number(config.OWNER_USER_ID.trim())
  : undefined;

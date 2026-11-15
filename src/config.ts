import 'dotenv/config';
import { z } from 'zod';
import { parseTelegramApiRoot, parseTelegramProxyUrl } from './telegram-proxy.js';

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const bool = z.enum(['true', 'false']);

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_PROXY_URL: z.string().default('').refine(
    (value) => {
      try {
        parseTelegramProxyUrl(value);
        return true;
      } catch {
        return false;
      }
    },
    'Expected empty or an http, https, socks5, or socks5h proxy URL with host and port',
  ),
  TELEGRAM_API_ROOT: z.string().default('').refine(
    (value) => {
      try {
        parseTelegramApiRoot(value);
        return true;
      } catch {
        return false;
      }
    },
    'Expected empty or an absolute http(s) Telegram API root URL with host (no path, query, hash, or credentials)',
  ),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default('gpt-4.1-mini'),
  OPENAI_BASE_URL: z.string().default(''),
  OPENAI_TIMEOUT_MS: integer(90000, 1000, 600000),
  OPENAI_MAX_RETRIES: integer(1, 0, 5),
  DATABASE_URL: z.string().default(''),
  PG_POOL_MAX: integer(10, 1, 100),
  PG_CONNECTION_TIMEOUT_MS: integer(10000, 1000, 120000),
  PG_IDLE_TIMEOUT_MS: integer(30000, 1000, 600000),
  PG_STATEMENT_TIMEOUT_MS: integer(15000, 1000, 300000),
  ALLOWED_CHAT_IDS: z.string().default('').refine(
    (value) => !value.trim() || value.split(',').every((id) => /^-\d+$/.test(id.trim())),
    'Expected comma-separated negative Telegram group IDs',
  ),
  /** Telegram user id of the bot owner; private /stats works only for this account. */
  OWNER_USER_ID: z.string().default('').refine(
    (value) => !value.trim() || /^\d+$/.test(value.trim()),
    'Expected numeric Telegram user id',
  ),
  SUMMARY_ADMIN_ONLY: bool.default('true'),
  DEFAULT_MESSAGE_COUNT: integer(100, 1, 10000),
  MAX_MESSAGE_COUNT: integer(1000, 1, 10000),
  MAX_INPUT_CHARS: integer(60000, 1000, 500000),
  MAX_OUTPUT_TOKENS: integer(1500, 256, 10000),
  SUMMARY_COOLDOWN_SECONDS: integer(10, 1, 86400),
  SUMMARY_REQUEST_RETENTION_DAYS: integer(2, 1, 365),
  SUMMARY_SARCASM_PERCENT: integer(0, 0, 100),
  GIF_ENABLED: bool.default('true'),
  GIPHY_API_KEY: z.string().default(''),
  GIF_DEFAULT_MESSAGE_COUNT: integer(40, 1, 10000),
  GIF_MAX_MESSAGE_COUNT: integer(80, 1, 10000),
  GIF_MAX_INPUT_CHARS: integer(12000, 1000, 100000),
  GIF_COOLDOWN_SECONDS: integer(10, 1, 3600),
  TELEGRAM_MAX_MESSAGE_LENGTH: integer(4000, 1000, 4096),
  TELEGRAM_MAX_CAPTION_LENGTH: integer(1024, 100, 1024),
  MEDIA_URL_MAX_LENGTH: integer(512, 64, 2048),
  PROCESS_MAX_STDOUT_BYTES: integer(4 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
  DOWNLOADER_HTTP_TIMEOUT_SECONDS: integer(15, 1, 120),
  DOWNLOADER_RETRIES: integer(1, 0, 10),
  GALLERY_ENABLED: bool.default('true'),
  GALLERY_MAX_IMAGES: integer(10, 1, 10),
  GALLERY_MAX_IMAGE_MB: integer(15, 1, 30),
  GALLERY_MAX_TOTAL_MB: integer(80, 1, 150),
  GALLERY_TIMEOUT_SECONDS: integer(180, 10, 600),
  GALLERY_DISK_CHECK_INTERVAL_MS: integer(500, 100, 10000),
  GALLERY_MAX_DIMENSION: integer(1920, 320, 4096),
  GALLERY_OUTPUT_MAX_MB: integer(10, 1, 20),
  GALLERY_METADATA_MAX_MB: integer(4, 1, 32),
  GALLERY_WHITELIST: z.string().min(1).default('instagram,twitter,reddit,pixiv,imgur'),
  INSTAGRAM_BROWSER_ENABLED: bool.default('true'),
  /** Hard cap for the whole Instagram fetch (gallery-dl + Playwright). */
  INSTAGRAM_DOWNLOAD_TIMEOUT_MS: integer(120000, 10000, 300000),
  /** Per page.goto / navigation timeout inside the Instagram browser fallback. */
  INSTAGRAM_BROWSER_TIMEOUT_MS: integer(40000, 5000, 120000),
  MARKETPLACE_ENABLED: bool.default('true'),
  MARKETPLACE_MAX_IMAGES: integer(5, 1, 10),
  MEDIA_MAX_CONCURRENT: z.coerce.number().int().min(1).max(3).optional(),
  MEDIA_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(3600).optional(),
  VIDEO_ENABLED: bool.default('true'),
  VIDEO_MAX_SIZE_MB: integer(45, 1, 45),
  VIDEO_MAX_DURATION_SECONDS: integer(180, 1, 600),
  VIDEO_TIMEOUT_SECONDS: integer(180, 10, 600),
  VIDEO_COOLDOWN_SECONDS: integer(10, 1, 3600),
  VIDEO_MAX_CONCURRENT: integer(1, 1, 3),
  VIDEO_MAX_HEIGHT: integer(1080, 240, 2160),
  VIDEO_FFMPEG_THREADS: integer(2, 1, 16),
  VIDEO_FFMPEG_PRESET: z.string().min(1).default('faster'),
  VIDEO_FFMPEG_CRF: integer(23, 0, 51),
  VIDEO_AUDIO_BITRATE: z.string().min(1).default('192k'),
  VIDEO_EXTRACTORS: z.string().min(1).default('youtube.*,tiktok.*,vm.tiktok.*,instagram.*,vk.*'),
  VIDEO_CACHE_SIZE: integer(1000, 0, 10000),
  MENTION_ENABLED: bool.default('true'),
  MENTION_MAX_INPUT_CHARS: integer(1500, 100, 8000),
  MENTION_MAX_OUTPUT_TOKENS: integer(600, 64, 4000),
  MENTION_COOLDOWN_SECONDS: integer(10, 1, 3600),
  MENTION_IMAGES_ENABLED: bool.default('true'),
  MENTION_MAX_IMAGES: integer(2, 0, 4),
  MENTION_VISION_ENABLED: bool.default('true'),
  MENTION_MAX_INPUT_IMAGES: integer(4, 0, 8),
  MENTION_MAX_INPUT_IMAGE_MB: integer(5, 1, 20),
  OPENAI_IMAGE_MODEL: z.string().min(1).default('gpt-image-1-mini'),
  OPENAI_INPUT_USD_PER_1M_TOKENS: z.coerce.number().min(0).max(1000).default(0.4),
  OPENAI_OUTPUT_USD_PER_1M_TOKENS: z.coerce.number().min(0).max(1000).default(1.6),
  OPENAI_IMAGE_USD: z.coerce.number().min(0).max(10).default(0.011),
  USAGE_RETENTION_DAYS: integer(90, 1, 3650),
  RETENTION_DAYS: integer(30, 1, 3650),
  RETENTION_CLEANUP_INTERVAL_MS: integer(3600000, 60000, 86400000),
});

export const config = schema.parse(process.env);
if (config.DEFAULT_MESSAGE_COUNT > config.MAX_MESSAGE_COUNT) {
  throw new Error('DEFAULT_MESSAGE_COUNT must not exceed MAX_MESSAGE_COUNT');
}
if (config.GIF_DEFAULT_MESSAGE_COUNT > config.GIF_MAX_MESSAGE_COUNT) {
  throw new Error('GIF_DEFAULT_MESSAGE_COUNT must not exceed GIF_MAX_MESSAGE_COUNT');
}
export const allowedChatIds = new Set(
  config.ALLOWED_CHAT_IDS.split(',').map((id) => id.trim()).filter(Boolean),
);
export const ownerUserId = config.OWNER_USER_ID.trim()
  ? Number(config.OWNER_USER_ID.trim())
  : undefined;

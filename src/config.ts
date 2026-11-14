import 'dotenv/config';
import { z } from 'zod';

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default('gpt-4.1-mini'),
  DATABASE_URL: z.string().default(''),
  ALLOWED_CHAT_IDS: z.string().default('').refine(
    (value) => !value.trim() || value.split(',').every((id) => /^-\d+$/.test(id.trim())),
    'Expected comma-separated negative Telegram group IDs',
  ),
  SUMMARY_ADMIN_ONLY: z.enum(['true', 'false']).default('true'),
  DEFAULT_MESSAGE_COUNT: integer(100, 1, 10000),
  MAX_MESSAGE_COUNT: integer(1000, 1, 10000),
  MAX_INPUT_CHARS: integer(60000, 1000, 500000),
  MAX_OUTPUT_TOKENS: integer(1500, 256, 10000),
  SUMMARY_COOLDOWN_SECONDS: integer(60, 1, 86400),
  GALLERY_ENABLED: z.enum(['true', 'false']).default('true'),
  GALLERY_MAX_IMAGES: integer(10, 1, 10),
  GALLERY_MAX_IMAGE_MB: integer(15, 1, 30),
  GALLERY_MAX_TOTAL_MB: integer(80, 1, 150),
  GALLERY_TIMEOUT_SECONDS: integer(180, 10, 600),
  MEDIA_MAX_CONCURRENT: z.coerce.number().int().min(1).max(3).optional(),
  MEDIA_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(3600).optional(),
  VIDEO_ENABLED: z.enum(['true', 'false']).default('true'),
  VIDEO_MAX_SIZE_MB: integer(45, 1, 45),
  VIDEO_MAX_DURATION_SECONDS: integer(180, 1, 600),
  VIDEO_TIMEOUT_SECONDS: integer(180, 10, 600),
  VIDEO_COOLDOWN_SECONDS: integer(30, 1, 3600),
  VIDEO_MAX_CONCURRENT: integer(1, 1, 3),
  RETENTION_DAYS: integer(30, 1, 3650),
});

export const config = schema.parse(process.env);
if (config.DEFAULT_MESSAGE_COUNT > config.MAX_MESSAGE_COUNT) {
  throw new Error('DEFAULT_MESSAGE_COUNT must not exceed MAX_MESSAGE_COUNT');
}
export const allowedChatIds = new Set(config.ALLOWED_CHAT_IDS.split(',').map((id) => id.trim()).filter(Boolean));

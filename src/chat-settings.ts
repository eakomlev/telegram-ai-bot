import { config } from './config.js';
import { getChatSettingsRow, upsertChatSettings, type ChatSettingsRow } from './db.js';
import { sanitizeSpheres, sphereLabel, type NewsSphereId } from './news-spheres.js';

export type ChatSettings = {
  summaryAdminOnly: boolean;
  defaultMessageCount: number;
  videoEnabled: boolean;
  galleryEnabled: boolean;
  mediaCooldownSeconds: number;
  sarcasmLevel: number;
  mentionEnabled: boolean;
  newsEnabled: boolean;
  newsSpheres: NewsSphereId[];
};

const COUNT_STEPS = [50, 100, 200, 500, 1000];
const COOLDOWN_STEPS = [10, 15, 30, 60, 120, 300];
const SARCASM_STEPS = [0, 25, 50, 75, 100];

export function defaultChatSettings(): ChatSettings {
  return {
    summaryAdminOnly: config.SUMMARY_ADMIN_ONLY === 'true',
    defaultMessageCount: config.DEFAULT_MESSAGE_COUNT,
    videoEnabled: config.VIDEO_ENABLED === 'true',
    galleryEnabled: config.GALLERY_ENABLED === 'true',
    mediaCooldownSeconds: config.MEDIA_COOLDOWN_SECONDS ?? config.VIDEO_COOLDOWN_SECONDS,
    sarcasmLevel: config.SUMMARY_SARCASM_PERCENT,
    mentionEnabled: config.MENTION_ENABLED === 'true',
    newsEnabled: false,
    newsSpheres: [],
  };
}

function fromRow(row: ChatSettingsRow): ChatSettings {
  return {
    summaryAdminOnly: row.summary_admin_only,
    defaultMessageCount: row.default_message_count,
    videoEnabled: row.video_enabled,
    galleryEnabled: row.gallery_enabled,
    mediaCooldownSeconds: row.media_cooldown_seconds,
    sarcasmLevel: row.sarcasm_level,
    mentionEnabled: row.mention_enabled ?? true,
    newsEnabled: row.news_enabled ?? false,
    newsSpheres: sanitizeSpheres(row.news_spheres ?? []),
  };
}

function clampCount(value: number) {
  return Math.min(Math.max(1, value), config.MAX_MESSAGE_COUNT);
}

function clampCooldown(value: number) {
  return Math.min(Math.max(1, value), 3600);
}

function clampSarcasm(value: number) {
  return Math.min(Math.max(0, Math.round(value)), 100);
}

export async function resolveChatSettings(chatId: number): Promise<ChatSettings> {
  const row = await getChatSettingsRow(chatId);
  if (!row) return defaultChatSettings();
  return {
    ...fromRow(row),
    defaultMessageCount: clampCount(row.default_message_count),
    mediaCooldownSeconds: clampCooldown(row.media_cooldown_seconds),
    sarcasmLevel: clampSarcasm(row.sarcasm_level ?? 0),
    mentionEnabled: row.mention_enabled ?? defaultChatSettings().mentionEnabled,
    newsEnabled: row.news_enabled ?? false,
    newsSpheres: sanitizeSpheres(row.news_spheres ?? []),
  };
}

export async function saveChatSettings(chatId: number, settings: ChatSettings) {
  const next: ChatSettings = {
    ...settings,
    defaultMessageCount: clampCount(settings.defaultMessageCount),
    mediaCooldownSeconds: clampCooldown(settings.mediaCooldownSeconds),
    sarcasmLevel: clampSarcasm(settings.sarcasmLevel),
    newsSpheres: sanitizeSpheres(settings.newsSpheres),
  };
  await upsertChatSettings(chatId, {
    summary_admin_only: next.summaryAdminOnly,
    default_message_count: next.defaultMessageCount,
    video_enabled: next.videoEnabled,
    gallery_enabled: next.galleryEnabled,
    media_cooldown_seconds: next.mediaCooldownSeconds,
    sarcasm_level: next.sarcasmLevel,
    mention_enabled: next.mentionEnabled,
    news_enabled: next.newsEnabled,
    news_spheres: next.newsSpheres,
    news_next_run_at: null,
    news_last_sent_on: null,
  });
  return next;
}

function nextStep(steps: number[], current: number, max: number) {
  const allowed = steps.filter((step) => step <= max);
  const list = allowed.length ? allowed : [Math.min(steps[0]!, max)];
  const index = list.indexOf(current);
  return list[(index + 1) % list.length]!;
}

export function cycleDefaultCount(current: number) {
  return nextStep(COUNT_STEPS, clampCount(current), config.MAX_MESSAGE_COUNT);
}

export function cycleMediaCooldown(current: number) {
  return nextStep(COOLDOWN_STEPS, clampCooldown(current), 3600);
}

export function cycleSarcasmLevel(current: number) {
  return nextStep(SARCASM_STEPS, clampSarcasm(current), 100);
}

export function formatSettings(settings: ChatSettings) {
  const on = (value: boolean) => (value ? 'вкл' : 'выкл');
  const spheres = settings.newsSpheres.length
    ? settings.newsSpheres.map((id) => sphereLabel(id)).join(', ')
    : 'не выбраны';
  return [
    'Настройки этой группы (видят и меняют только администраторы):',
    '',
    `• Саммари только админам: ${on(settings.summaryAdminOnly)}`,
    `• Сообщений по умолчанию в /summary: ${settings.defaultMessageCount}`,
    `• Сарказм: ${settings.sarcasmLevel}%`,
    `• Ответы на @упоминания: ${on(settings.mentionEnabled)}`,
    `• Автозагрузка видео: ${on(settings.videoEnabled)}`,
    `• Автозагрузка картинок: ${on(settings.galleryEnabled)}`,
    `• Пауза между медиа-ссылками: ${settings.mediaCooldownSeconds} сек.`,
    `• Ежедневная новость: ${on(settings.newsEnabled)}`,
    `• Сферы новостей: ${spheres}`,
  ].join('\n');
}

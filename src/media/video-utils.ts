import { config } from '../config.js';

export type VideoSource = { url: string; platform: string };

/** Only standalone links to explicitly supported post types, never arbitrary URLs. */
export function parseVideoLink(text: string): VideoSource | undefined {
  if (text.trim().length > config.MEDIA_URL_MAX_LENGTH) return;
  let url: URL;
  try { url = new URL(text.trim()); } catch { return; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname;
  let platform: string | undefined;
  if ((host === 'youtube.com' || host === 'm.youtube.com') && /^\/shorts\/[\w-]+\/?$/.test(path)) platform = 'YouTube Shorts';
  if (host === 'youtu.be' && /^\/[\w-]+\/?$/.test(path)) platform = 'YouTube';
  if ((host === 'tiktok.com' || host === 'm.tiktok.com') && /^(?:\/@[^/]+\/video\/\d+|\/t\/[\w-]+)\/?$/.test(path)) platform = 'TikTok';
  if ((host === 'vm.tiktok.com' || host === 'vt.tiktok.com') && /^\/[\w-]+\/?$/.test(path)) platform = 'TikTok';
  if (host === 'instagram.com' && /^\/(?:reel|reels)\/[\w-]+\/?$/.test(path)) platform = 'Instagram Reels';
  if (['vk.com', 'm.vk.com', 'vkvideo.ru'].includes(host) && /^\/clip-?\d+_\d+\/?$/.test(path)) platform = 'VK Клипы';
  if (!platform || /\s/.test(text.trim())) return;
  url.hash = '';
  url.search = '';
  return { url: url.toString(), platform };
}

export type VideoMetadata = {
  title?: string; description?: string; uploader?: string; channel?: string;
  upload_date?: string; duration?: number; view_count?: number; like_count?: number;
  is_live?: boolean; live_status?: string; _type?: string;
};
const clean = (value: unknown, limit: number) => typeof value === 'string'
  ? Array.from(value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()).slice(0, limit).join('') : '';

export function validateVideoMetadata(info: VideoMetadata, maxSeconds: number) {
  if (info._type === 'playlist' || info.is_live || ['is_live', 'is_upcoming'].includes(info.live_status ?? '')) throw new Error('unsupported');
  // Instagram often omits duration until after download; ffprobe enforces the limit later.
  if (info.duration == null) return;
  if (typeof info.duration !== 'number' || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > maxSeconds) {
    throw new Error('duration');
  }
}

/** User-facing video download/repost errors; classify without blaming limits for anti-bot blocks. */
export function formatVideoRepostError(
  error: unknown,
  limits: { maxDurationSeconds: number; maxSizeMb: number },
): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const msg = raw.toLowerCase();

  if (
    msg === 'duration'
    || /duration[-\s]?filter|filter[^\n]{0,80}duration|max-?duration|duration[^\n]{0,40}limit/i.test(raw)
  ) {
    return `Не удалось загрузить ролик: превышен лимит длительности (${limits.maxDurationSeconds} сек.).`;
  }
  if (msg === 'size' || /max-?filesize|file is larger than max-filesize/i.test(raw)) {
    return `Не удалось загрузить ролик: превышен лимит размера (${limits.maxSizeMb} МБ).`;
  }
  if (msg === 'timeout' || /process timed out|timed out/i.test(raw)) {
    return 'Не удалось загрузить ролик: истекло время ожидания.';
  }
  if (/process cancelled/i.test(raw)) {
    return 'Не удалось загрузить ролик.';
  }
  if (
    /sign in to confirm|not a bot|login required|please log in|http error 403|private video|video unavailable/i
      .test(raw)
  ) {
    return 'Не удалось загрузить ролик: сервис ограничил доступ (проверка на бота или требуется вход).';
  }
  if (msg === 'missing video') return 'Не удалось загрузить ролик: файл видео не найден.';
  if (msg === 'incomplete video') return 'Не удалось загрузить ролик: видео обработано неполностью.';
  if (msg === 'dimensions') return 'Не удалось загрузить ролик: некорректные размеры видео.';
  if (msg === 'unsupported') return 'Не удалось загрузить ролик: этот тип публикации не поддерживается.';

  return 'Не удалось загрузить ролик. Возможно, публикация закрыта или сервис ограничил доступ.';
}

export function videoCaption(info: VideoMetadata, source: VideoSource): string {
  const lines = [source.platform, clean(info.title, 160)];
  const author = clean(info.uploader ?? info.channel, 100);
  if (author) lines.push(`Автор: ${author}`);
  if (typeof info.upload_date === 'string' && /^\d{8}$/.test(info.upload_date)) {
    lines.push(`Дата: ${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`);
  }
  if (typeof info.duration === 'number' && Number.isFinite(info.duration)) lines.push(`Длительность: ${Math.round(info.duration)} сек.`);
  const stats: string[] = [];
  for (const [name, count] of [['Просмотры', info.view_count], ['Лайки', info.like_count]] as const) {
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) stats.push(`${name}: ${Math.floor(count).toLocaleString('ru-RU')}`);
  }
  if (stats.length) lines.push(stats.join(' · '));
  const description = clean(info.description, 1200);
  // Telegram caption limit counts UTF-16 units conservatively; always preserve the source URL.
  const suffix = `\n\nИсточник: ${source.url}`;
  const header = lines.filter(Boolean).join('\n');
  const available = Math.max(0, config.TELEGRAM_MAX_CAPTION_LENGTH - suffix.length);
  const body = (header + (description ? `\n\n${description}` : '')).slice(0, available);
  return body.replace(/[\uD800-\uDBFF]$/, '') + suffix;
}

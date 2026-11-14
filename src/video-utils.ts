export type VideoSource = { url: string; platform: string };

/** Only standalone links to explicitly supported post types, never arbitrary URLs. */
export function parseVideoLink(text: string): VideoSource | undefined {
  if (text.trim().length > 512) return;
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
  if (typeof info.duration !== 'number' || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > maxSeconds) throw new Error('duration');
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
  const available = Math.max(0, 1024 - suffix.length);
  const body = (header + (description ? `\n\n${description}` : '')).slice(0, available);
  return body.replace(/[\uD800-\uDBFF]$/, '') + suffix;
}

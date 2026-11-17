import type { MessageEntity } from 'grammy/types';
import { config } from '../config.js';
import { parseMarketplaceLink } from './marketplace.js';
import { videoCaption, type VideoSource, type VideoMetadata } from './video-utils.js';

export function parseGalleryLink(text: string, entities: MessageEntity[] = []): VideoSource | undefined {
  const marketplace = parseMarketplaceLink(text, entities);
  if (marketplace) return marketplace;

  const value = text.trim();
  if (value.length > config.MEDIA_URL_MAX_LENGTH || /\s/.test(value)) return;
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let platform: string | undefined;
  if (host === 'instagram.com' && /^\/p\/[\w-]+\/?$/.test(url.pathname)) platform = 'Instagram';
  if (['x.com', 'twitter.com', 'mobile.twitter.com'].includes(host) && /^\/[\w]+\/status\/\d+\/?$/.test(url.pathname)) platform = 'X / Twitter';
  if (['reddit.com', 'old.reddit.com'].includes(host) && /^\/r\/[\w]+\/comments\/[a-z0-9]+(?:\/[^/]+)?\/?$/i.test(url.pathname)) platform = 'Reddit';
  if (host === 'pixiv.net' && /^\/(?:[a-z]{2}\/)?artworks\/\d+\/?$/.test(url.pathname)) platform = 'Pixiv';
  if (host === 'imgur.com' && /^\/(?:a|gallery)\/[\w]+\/?$/.test(url.pathname)) platform = 'Imgur';
  if (!platform) return;
  url.search = '';
  url.hash = '';
  return { url: url.toString(), platform };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function author(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return text(row.full_name) ?? text(row.name) ?? text(row.username) ?? text(row.nick);
  }
}
export function galleryCaption(info: Record<string, unknown>, source: VideoSource, limited: boolean): string {
  const date = text(info.date) ?? text(info.date_posted);
  const isProduct = info.extractor === 'marketplace-browser';
  const normalized: VideoMetadata = {
    title: text(info.title),
    description: isProduct
      ? undefined
      : text(info.description) ?? text(info.content) ?? text(info.caption) ?? text(info.text),
    uploader: isProduct ? undefined : author(info.user) ?? author(info.author) ?? author(info.uploader),
    upload_date: isProduct ? undefined : date?.slice(0, 10).replace(/-/g, ''),
    like_count: isProduct
      ? undefined
      : typeof info.favorite_count === 'number' ? info.favorite_count : typeof info.likes === 'number' ? info.likes : undefined,
  };
  if (limited) {
    normalized.title = `${normalized.title ?? (isProduct ? 'Товар' : 'Изображения поста')} (показаны первые изображения в пределах лимита)`;
  }
  return videoCaption(normalized, source);
}

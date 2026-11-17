import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MessageEntity } from 'grammy/types';
import { config } from '../config.js';
import type { VideoSource } from './video-utils.js';

const PLATFORM = 'Wildberries';
const HTTPS_URL_RE = /https:\/\/[^\s<>"']+/gi;

export function isMarketplacePlatform(platform: string) {
  return platform === PLATFORM;
}

function trimUrlJunk(value: string) {
  return value.replace(/[)\]},.;:!?'"»]+$/g, '').trim();
}

/** Collect https candidates from plain text and Telegram url / text_link entities. */
export function collectMarketplaceUrlCandidates(text: string, entities: MessageEntity[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const cleaned = trimUrlJunk(raw);
    if (!cleaned.startsWith('https://') || cleaned.length > config.MEDIA_URL_MAX_LENGTH || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };

  const trimmed = text.trim();
  if (trimmed && !/\s/.test(trimmed)) add(trimmed);

  for (const entity of entities) {
    if (entity.type === 'url') {
      add(text.slice(entity.offset, entity.offset + entity.length));
    } else if (entity.type === 'text_link' && entity.url) {
      add(entity.url);
    }
  }

  HTTPS_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTTPS_URL_RE.exec(text))) add(match[0]);
  return out;
}

function parseMarketplaceUrl(value: string): VideoSource | undefined {
  if (value.length > config.MEDIA_URL_MAX_LENGTH || /\s/.test(value)) return;
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname;
  if (
    !(host === 'wildberries.ru' || host === 'wb.ru' || host.endsWith('.wildberries.ru'))
    || !(/^\/catalog\/\d+\/detail\.aspx$/i.test(path) || /^\/\d+\/detail\.aspx$/i.test(path))
  ) {
    return;
  }
  url.search = '';
  url.hash = '';
  return { url: url.toString(), platform: PLATFORM };
}

/** Wildberries product card links (standalone or inside titled messages). */
export function parseMarketplaceLink(text: string, entities: MessageEntity[] = []): VideoSource | undefined {
  for (const candidate of collectMarketplaceUrlCandidates(text, entities)) {
    const parsed = parseMarketplaceUrl(candidate);
    if (parsed) return parsed;
  }
}

export function isMarketplaceCdnImage(url: string, platform: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (platform !== PLATFORM) return false;
  const lower = url.toLowerCase();
  if (/sprite|icon|logo|favicon|pixel|1x1|\.svg(\?|$)/i.test(lower)) return false;
  return /(wbbasket\.ru|geobasket\.ru|wbstatic\.net|wildberries\.ru|wb\.ru)/i.test(lower);
}

export function cleanProductTitle(value: string, platform: string) {
  let title = value.replace(/\s+/g, ' ').trim();
  title = title
    .replace(/\s*[|\u2014\-]\s*(Wildberries|WILDBERRIES).*$/i, '')
    .replace(/\s+купить.*$/i, '')
    .trim();
  if (!title) title = platform;
  return Array.from(title).slice(0, 200).join('');
}

export function wildberriesArticleId(url: string): number | undefined {
  try {
    const path = new URL(url).pathname;
    const match = /^\/catalog\/(\d+)\/detail\.aspx$/i.exec(path) ?? /^\/(\d+)\/detail\.aspx$/i.exec(path);
    if (!match?.[1]) return;
    const nm = Number(match[1]);
    return Number.isSafeInteger(nm) && nm > 0 ? nm : undefined;
  } catch {
    return;
  }
}

export function wildberriesVolPart(nm: number) {
  return { vol: Math.floor(nm / 100_000), part: Math.floor(nm / 1_000) };
}

type WbVolHost = { vol_range_from?: number; vol_range_to?: number; host?: string };

export function pickWildberriesBasketHost(vol: number, hosts: WbVolHost[]): string | undefined {
  const match = hosts.find((row) =>
    typeof row.host === 'string'
    && typeof row.vol_range_from === 'number'
    && typeof row.vol_range_to === 'number'
    && vol >= row.vol_range_from
    && vol <= row.vol_range_to);
  return match?.host;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json,image/webp,*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

async function resolveWildberriesBasketHost(nm: number, signal?: AbortSignal): Promise<string> {
  const { vol, part } = wildberriesVolPart(nm);
  try {
    const upstreams = await fetchJson('https://cdn.wbbasket.ru/api/v3/upstreams', signal) as {
      origin?: { mediabasket_route_map?: Array<{ hosts?: WbVolHost[] }> };
    };
    const hosts = upstreams.origin?.mediabasket_route_map?.[0]?.hosts ?? [];
    const host = pickWildberriesBasketHost(vol, hosts);
    if (host) return host;
  } catch {
    // fall through to probing
  }

  for (let basket = 1; basket <= 70; basket++) {
    if (signal?.aborted) throw new Error('aborted');
    const host = `basket-${String(basket).padStart(2, '0')}.wbbasket.ru`;
    try {
      await fetchJson(`https://${host}/vol${vol}/part${part}/${nm}/info/ru/card.json`, signal);
      return host;
    } catch {
      // try next shard
    }
  }
  throw new Error('wildberries basket not found');
}

async function writeMarketplaceFiles(
  directory: string,
  title: string,
  platform: string,
  buffers: Buffer[],
  signal?: AbortSignal,
) {
  const files: string[] = [];
  for (const [index, buffer] of buffers.entries()) {
    if (signal?.aborted) throw new Error('aborted');
    const webp = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46;
    const filename = `mp-${index}.${webp ? 'webp' : 'jpg'}`;
    const path = join(directory, filename);
    await writeFile(path, buffer);
    await writeFile(
      `${path}.json`,
      JSON.stringify({
        title,
        description: '',
        extractor: 'marketplace-browser',
        platform,
      }),
    );
    files.push(filename);
  }
  return {
    files,
    info: {
      title,
      description: '',
      extractor: 'marketplace-browser',
      platform,
    },
  };
}

/** Pull Wildberries title/images from public CDN card.json (site blocks headless browsers). */
export async function downloadMarketplaceProduct(
  source: VideoSource,
  directory: string,
  options: {
    maxImages: number;
    maxBytesPerImage: number;
    signal?: AbortSignal;
  },
): Promise<{ files: string[]; info: Record<string, unknown> }> {
  if (source.platform !== PLATFORM) throw new Error('unsupported marketplace');
  const nm = wildberriesArticleId(source.url);
  if (!nm) throw new Error('wildberries article missing');
  const { vol, part } = wildberriesVolPart(nm);
  const host = await resolveWildberriesBasketHost(nm, options.signal);
  const card = await fetchJson(
    `https://${host}/vol${vol}/part${part}/${nm}/info/ru/card.json`,
    options.signal,
  ) as {
    imt_name?: string;
    name?: string;
    media?: { photo_count?: number };
  };
  const title = cleanProductTitle(card.imt_name || card.name || source.platform, source.platform);
  const photoCount = Math.max(1, Math.min(
    typeof card.media?.photo_count === 'number' ? card.media.photo_count : options.maxImages,
    Math.max(options.maxImages * 3, options.maxImages),
  ));
  const buffers: Buffer[] = [];
  for (let index = 1; index <= photoCount && buffers.length < options.maxImages; index++) {
    if (options.signal?.aborted) throw new Error('aborted');
    let got = false;
    for (const size of ['big', 'c516x688', 'huge']) {
      const url = `https://${host}/vol${vol}/part${part}/${nm}/images/${size}/${index}.webp`;
      try {
        const res = await fetch(url, {
          signal: options.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'image/webp,image/*,*/*',
          },
        });
        if (!res.ok) continue;
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length < 5_000 || buffer.length > options.maxBytesPerImage) continue;
        buffers.push(buffer);
        got = true;
        break;
      } catch {
        // try next size / index
      }
    }
    if (!got && index === 1) break;
  }
  if (!buffers.length) throw new Error('no marketplace images');
  return writeMarketplaceFiles(directory, title, source.platform, buffers, options.signal);
}

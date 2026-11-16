import { config } from './config.js';

type GiphyImage = { url?: string; mp4?: string; size?: string | number };
type GiphyItem = {
  images?: {
    original?: GiphyImage;
    downsized_medium?: GiphyImage;
    downsized?: GiphyImage;
    fixed_height?: GiphyImage;
    preview_gif?: GiphyImage;
  };
};

function sizeOf(value: string | number | undefined) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function pickAnimationUrl(item: GiphyItem): string | undefined {
  const images = item.images;
  if (!images) return;

  const mp4Candidates = [images.fixed_height?.mp4, images.original?.mp4];
  for (const url of mp4Candidates) {
    const trimmed = url?.trim();
    if (trimmed) return trimmed;
  }

  const gifCandidates = [
    images.downsized_medium,
    images.downsized,
    images.fixed_height,
    images.original,
  ];
  for (const media of gifCandidates) {
    if (!media?.url?.trim()) continue;
    const bytes = sizeOf(media.size);
    if (bytes != null && bytes > 8 * 1024 * 1024) continue;
    return media.url.trim();
  }
}

/** Search Giphy and return public animation URLs for Telegram sendAnimation. */
export async function searchGiphyAnimations(query: string, limit = 8): Promise<string[]> {
  if (!config.GIPHY_API_KEY.trim()) return [];
  const params = new URLSearchParams({
    api_key: config.GIPHY_API_KEY,
    q: query,
    limit: String(Math.min(25, Math.max(1, limit))),
    rating: 'pg-13',
    lang: 'ru',
    bundle: 'messaging_non_clips',
  });
  const response = await fetch(`https://api.giphy.com/v1/gifs/search?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    console.error('Giphy search failed', { status: response.status });
    return [];
  }
  const body = (await response.json()) as { data?: GiphyItem[] };
  const urls: string[] = [];
  for (const row of body.data ?? []) {
    const url = pickAnimationUrl(row);
    if (url) urls.push(url);
  }
  return urls;
}

export function pickRandomUrl(urls: string[]): string | undefined {
  if (!urls.length) return;
  return urls[Math.floor(Math.random() * urls.length)];
}

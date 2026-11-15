import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';

export function instagramShortcode(url: string): string | undefined {
  const match = /instagram\.com\/(?:p|reel|reels)\/([\w-]+)/i.exec(url);
  return match?.[1];
}

/** Instagram often serves JPEG/WebP under paths ending in .heic with stp=dst-jpg_*. */
export function isLikelyInstagramPostImage(url: string): boolean {
  if (!/cdninstagram\.com|fbcdn\.net/i.test(url)) return false;
  if (/static\.cdninstagram\.com/i.test(url)) return false;
  if (/t51\.2885-19|t51\.82787-19/.test(url)) return false; // profile / story-ish avatars
  if (/s150x150|s320x320|p150x150|p320x320/.test(url)) return false;
  const path = (url.split('?')[0] ?? '').toLowerCase();
  if (/\.(jpe?g|png|webp|heic)$/.test(path)) return true;
  if (/\/v\/t51\./.test(url)) return true;
  return false;
}

function normalizeImageKey(url: string) {
  const path = url.split('?')[0] ?? url;
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.(jpe?g|png|webp|heic)$/i, '');
}

function mediaIdFromUrl(url: string): string | undefined {
  const file = (url.split('?')[0] ?? '').split('/').pop() ?? '';
  const match = /^(\d+_\d+)/.exec(file);
  return match?.[1];
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Best-effort public Instagram post scrape via headless Chromium.
 * Uses the embed page so related-feed thumbnails are not mixed in.
 */
export async function downloadInstagramWithBrowser(
  postUrl: string,
  directory: string,
  options: {
    maxImages: number;
    maxBytesPerImage: number;
    signal?: AbortSignal;
  },
): Promise<{ files: string[]; info: Record<string, unknown> }> {
  const shortcode = instagramShortcode(postUrl);
  if (!shortcode) throw new Error('instagram shortcode');

  const collected = new Map<string, Buffer>();
  const rememberBuffer = (url: string, buffer: Buffer) => {
    if (!isLikelyInstagramPostImage(url)) return;
    if (buffer.length < 8_000 || buffer.length > options.maxBytesPerImage) return;
    const key = normalizeImageKey(url);
    const previous = collected.get(key);
    if (!previous || buffer.length > previous.length) collected.set(key, buffer);
  };

  const signal = options.signal ?? AbortSignal.timeout(config.INSTAGRAM_DOWNLOAD_TIMEOUT_MS);
  const navTimeout = config.INSTAGRAM_BROWSER_TIMEOUT_MS;
  const imageTimeout = Math.min(20_000, navTimeout);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const onAbort = () => {
    void browser.close().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal.aborted) throw new Error('aborted');
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 900, height: 1200 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const page = await context.newPage();

    // Capture network images only while scraping the embed (no related feed).
    let capture = false;
    page.on('response', (response) => {
      if (!capture) return;
      void (async () => {
        try {
          const url = response.url();
          if (!isLikelyInstagramPostImage(url)) return;
          const type = response.headers()['content-type'] ?? '';
          if (!type.startsWith('image/')) return;
          const body = await response.body();
          rememberBuffer(url, Buffer.from(body));
        } catch {
          // response body may be unavailable
        }
      })();
    });

    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    capture = true;
    await page.goto(embedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: navTimeout,
    });
    await sleep(1200, signal);

    for (const label of ['Allow all cookies', 'Accept All', 'Accept', 'Not Now', 'Close', 'Decline optional cookies']) {
      if (signal.aborted) throw new Error('aborted');
      await page.getByRole('button', { name: label }).first().click({ timeout: 500 }).catch(() => {});
    }

    let caption = '';
    let author = '';
    const ogTitle = await page.locator('meta[property="og:title"]').first().getAttribute('content').catch(() => null);
    const ogDesc = await page.locator('meta[property="og:description"]').first().getAttribute('content').catch(() => null);
    if (ogTitle) author = ogTitle.split('•')[0]?.trim() || ogTitle;
    if (ogDesc) caption = ogDesc;

    const downloadSrc = async (src: string | null | undefined) => {
      if (!src || signal.aborted) return;
      try {
        const res = await context.request.get(src, { timeout: imageTimeout });
        if (res.ok()) rememberBuffer(src, Buffer.from(await res.body()));
      } catch {
        // ignore
      }
    };

    // Primary: dedicated embed media image(s), not the surrounding page chrome.
    const collectEmbedDom = async () => {
      if (signal.aborted) throw new Error('aborted');
      const sources = await page.locator('img.EmbeddedMediaImage').evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src).filter(Boolean),
      );
      for (const src of sources) await downloadSrc(src);
    };

    await collectEmbedDom();

    // Carousel on embed (when present).
    for (let step = 0; step < options.maxImages - 1; step += 1) {
      if (signal.aborted) throw new Error('aborted');
      const next = page.locator('button[aria-label="Next"], [aria-label="Next"], .coreSpriteRightChevron').first();
      if (!(await next.count())) break;
      await next.click({ timeout: 1200 }).catch(() => undefined);
      await sleep(700, signal);
      await collectEmbedDom();
    }

    await sleep(400, signal);
    capture = false;

    // Fallback: og:image from the regular post page (single image posts).
    if (!collected.size) {
      if (signal.aborted) throw new Error('aborted');
      await page.goto(`https://www.instagram.com/p/${shortcode}/`, {
        waitUntil: 'domcontentloaded',
        timeout: navTimeout,
      });
      await sleep(1000, signal);
      const ogImage = await page.locator('meta[property="og:image"]').first().getAttribute('content').catch(() => null);
      await downloadSrc(ogImage);
      if (!author) {
        const title = await page.locator('meta[property="og:title"]').first().getAttribute('content').catch(() => null);
        if (title) author = title.split('•')[0]?.trim() || title;
      }
      if (!caption) {
        const desc = await page.locator('meta[property="og:description"]').first().getAttribute('content').catch(() => null);
        if (desc) caption = desc;
      }
      // If og gave us one media id, keep only buffers for that id (ignore related feed).
      if (ogImage && collected.size > 1) {
        const want = mediaIdFromUrl(ogImage);
        if (want) {
          for (const key of [...collected.keys()]) {
            if (!key.startsWith(want)) collected.delete(key);
          }
        }
      }
    }

    const buffers = [...collected.values()].sort((a, b) => b.length - a.length).slice(0, options.maxImages);
    if (!buffers.length) throw new Error('no instagram images');

    const files: string[] = [];
    for (const [index, buffer] of buffers.entries()) {
      if (signal.aborted) throw new Error('aborted');
      const filename = `ig-${index}.jpg`;
      const path = join(directory, filename);
      await writeFile(path, buffer);
      await writeFile(
        `${path}.json`,
        JSON.stringify({
          title: author || 'Instagram',
          description: caption,
          user: { name: author || undefined },
          extractor: 'instagram-browser',
        }),
      );
      files.push(filename);
    }
    return {
      files,
      info: {
        title: author || 'Instagram',
        description: caption,
        user: { name: author || undefined },
        extractor: 'instagram-browser',
      },
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}

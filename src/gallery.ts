import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputFile, type Context } from 'grammy';
import { config } from './config.js';
import { enqueueMedia, mediaSignal, mediaClosing } from './media-jobs.js';
import { runProcess } from './process.js';
import { resolveChatSettings } from './chat-settings.js';
import { galleryCaption, parseGalleryLink } from './gallery-utils.js';
import { downloadMarketplaceProduct, isMarketplacePlatform } from './marketplace.js';
import { startStatus } from './status.js';

type Source = NonNullable<ReturnType<typeof parseGalleryLink>>;
export async function repostGallery(ctx: Context, source: Source, execute = runProcess) {
  let directory: string | undefined;
  let monitor: NodeJS.Timeout | undefined;
  let status: Awaited<ReturnType<typeof startStatus>> | undefined;
  let actionTimer: NodeJS.Timeout | undefined;
  const local = new AbortController();
  const signal = AbortSignal.any([mediaSignal, local.signal, AbortSignal.timeout(config.GALLERY_TIMEOUT_SECONDS * 1000)]);
  const deadline = Date.now() + config.GALLERY_TIMEOUT_SECONDS * 1000;
  const run = (command: string, args: string[]) => execute(command, args, Math.max(1, deadline - Date.now()), signal);
  const reply = { reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true },
    ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}) };
  try {
    status = await startStatus(ctx, '⏳ Загружаю картинки…', reply);
    actionTimer = setInterval(() => { void ctx.replyWithChatAction('upload_photo').catch(() => {}); }, 4000);
    actionTimer.unref();
    directory = await mkdtemp(join(tmpdir(), 'telegram-gallery-'));
    const root = directory;
    const totalLimit = config.GALLERY_MAX_TOTAL_MB * 1024 * 1024;
    // Also bounds partial downloads when an upstream server omits Content-Length.
    let inspecting = false;
    monitor = setInterval(() => {
      if (inspecting) return;
      inspecting = true;
      void (async () => {
        let total = 0;
        for (const file of await readdir(root)) total += (await stat(join(root, file)).catch(() => ({ size: 0 }))).size;
        if (total > totalLimit) local.abort();
      })().catch(() => local.abort()).finally(() => { inspecting = false; });
    }, config.GALLERY_DISK_CHECK_INTERVAL_MS);
    let entries: string[] = [];
    let inputs: string[] = [];
    let info: Record<string, unknown> = {};
    const isInstagram = source.platform === 'Instagram';
    const fetchSignal = isInstagram
      ? AbortSignal.any([signal, AbortSignal.timeout(config.INSTAGRAM_DOWNLOAD_TIMEOUT_MS)])
      : signal;
    const fetchDeadline = isInstagram
      ? Math.min(deadline, Date.now() + config.INSTAGRAM_DOWNLOAD_TIMEOUT_MS)
      : deadline;

    if (isMarketplacePlatform(source.platform)) {
      if (config.MARKETPLACE_ENABLED !== 'true') throw new Error('marketplace disabled');
      const product = await downloadMarketplaceProduct(source, root, {
        maxImages: Math.min(config.MARKETPLACE_MAX_IMAGES, config.GALLERY_MAX_IMAGES),
        maxBytesPerImage: config.GALLERY_MAX_IMAGE_MB * 1024 * 1024,
        signal,
      });
      info = product.info;
      entries = await readdir(root);
      inputs = entries.filter((file) => /\.(jpe?g|png|webp|avif)$/i.test(file)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    } else {
      await execute('gallery-dl', ['--config-ignore', '--no-input', '--no-colors', '--no-mtime',
        '--cache-file', ':memory:',
        '--http-timeout', String(config.DOWNLOADER_HTTP_TIMEOUT_SECONDS),
        '--retries', String(config.DOWNLOADER_RETRIES),
        '--directory', root, '--restrict-filenames', 'windows',
        '--range', `1-${config.GALLERY_MAX_IMAGES}`, '--post-range', '1', '--child-range', '1',
        '--whitelist', config.GALLERY_WHITELIST,
        '--filter', "extension in ('jpg', 'jpeg', 'png', 'webp', 'avif')",
        '--filesize-max', `${config.GALLERY_MAX_IMAGE_MB}M`, '--write-metadata', '--', source.url],
      Math.max(1, fetchDeadline - Date.now()), fetchSignal);
      entries = await readdir(root);
      inputs = entries.filter((file) => /\.(jpe?g|png|webp|avif)$/i.test(file)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    }
    clearInterval(monitor);
    if (!inputs.length) throw new Error('no images');
    const selected = inputs.slice(0, config.GALLERY_MAX_IMAGES);
    const output: string[] = [];
    let total = 0;
    for (const [index, filename] of selected.entries()) {
      const input = join(root, filename);
      const size = (await stat(input)).size;
      total += size;
      if (!size || size > config.GALLERY_MAX_IMAGE_MB * 1024 * 1024 || total > totalLimit) throw new Error('size');
      if (index === 0 && !Object.keys(info).length) {
        const metadataPath = input + '.json';
        if ((await stat(metadataPath)).size > config.GALLERY_METADATA_MAX_MB * 1024 * 1024) throw new Error('metadata size');
        const metadata: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('metadata');
        info = metadata as Record<string, unknown>;
      }
      const target = join(root, `telegram-${index}.jpg`);
      const dim = config.GALLERY_MAX_DIMENSION;
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-frames:v', '1',
        '-vf', `scale=w='min(${dim},iw)':h='min(${dim},ih)':force_original_aspect_ratio=decrease,pad=w='ceil(max(iw,ih/20)/2)*2':h='ceil(max(ih,iw/20)/2)*2':x='(ow-iw)/2':y='(oh-ih)/2'`,
        '-threads', '1', '-q:v', '3', '-y', target]);
      if ((await stat(target)).size > config.GALLERY_OUTPUT_MAX_MB * 1024 * 1024) throw new Error('photo size');
      output.push(target);
    }
    const caption = galleryCaption(info, source, inputs.length >= config.GALLERY_MAX_IMAGES);
    // Native signals are supported at runtime; grammY's declaration uses its legacy polyfill.
    const telegramSignal = signal as unknown as Parameters<Context['replyWithPhoto']>[2];
    if (output.length === 1) {
      await ctx.replyWithPhoto(new InputFile(output[0]!), { ...reply, caption }, telegramSignal);
    } else {
      await ctx.replyWithMediaGroup(output.map((path, index) => ({ type: 'photo' as const, media: new InputFile(path),
        ...(index === 0 ? { caption } : {}) })), reply, telegramSignal);
    }
    await status.clear();
  } catch {
    if (!mediaClosing()) {
      console.error('Gallery repost failed', { chatId: ctx.chat?.id, platform: source.platform });
      const errorText = 'Не удалось загрузить картинки: пост может требовать входа, не содержать доступных изображений или превышать лимиты.';
      if (status) await status.fail(errorText);
      else await ctx.reply(errorText, reply).catch(() => {});
    }
  } finally {
    if (actionTimer) clearInterval(actionTimer);
    if (monitor) clearInterval(monitor);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => console.error('Gallery temp cleanup failed'));
  }
}
export async function maybeRepostGallery(ctx: Context) {
  if (!ctx.message?.text || !ctx.chat) return;
  const settings = await resolveChatSettings(ctx.chat.id);
  if (!settings.galleryEnabled) return;
  const source = parseGalleryLink(ctx.message.text, ctx.message.entities ?? []);
  if (source) {
    await enqueueMedia(ctx, () => repostGallery(ctx, source), { cooldownSeconds: settings.mediaCooldownSeconds });
  }
}

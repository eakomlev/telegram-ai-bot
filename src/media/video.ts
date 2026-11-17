import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputFile, type Context } from 'grammy';
import { config } from '../config.js';
import { deleteVideoCache, getVideoCache, saveVideoCache } from '../core/db.js';
import { runProcess } from '../core/process.js';
import { parseVideoLink, validateVideoMetadata, type VideoMetadata } from './video-utils.js';

import { resolveChatSettings } from '../chat/chat-settings.js';
import { enqueueMedia, mediaSignal, mediaClosing } from '../core/media-jobs.js';
import { startStatus } from '../core/status.js';

function videoQualityKey() {
  return [
    config.VIDEO_MAX_HEIGHT,
    config.VIDEO_FFMPEG_CRF,
    config.VIDEO_FFMPEG_PRESET,
    config.VIDEO_AUDIO_BITRATE,
    config.VIDEO_MAX_SIZE_MB,
  ].join(':');
}

async function sendCached(
  ctx: Context,
  source: NonNullable<ReturnType<typeof parseVideoLink>>,
  reply: Record<string, unknown>,
) {
  const cached = await getVideoCache(source.url, videoQualityKey());
  if (!cached) return false;
  try {
    await ctx.replyWithVideo(cached.file_id, {
      ...reply,
      supports_streaming: true,
      width: cached.width,
      height: cached.height,
      duration: cached.duration,
    });
    return true;
  } catch {
    await deleteVideoCache(source.url).catch(() => {});
    return false;
  }
}

async function repost(ctx: Context, source: NonNullable<ReturnType<typeof parseVideoLink>>) {
  let directory: string | undefined;
  let status: Awaited<ReturnType<typeof startStatus>> | undefined;
  let actionTimer: NodeJS.Timeout | undefined;
  const deadline = Date.now() + config.VIDEO_TIMEOUT_SECONDS * 1000;
  const run = (command: string, args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timeout');
    return runProcess(command, args, remaining, mediaSignal);
  };
  const reply = { reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true },
    ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}) };
  try {
    if (await sendCached(ctx, source, reply)) return;
    status = await startStatus(ctx, '⏳ Загружаю видео…', reply);
    actionTimer = setInterval(() => { void ctx.replyWithChatAction('upload_video').catch(() => {}); }, 4000);
    actionTimer.unref();
    directory = await mkdtemp(join(tmpdir(), 'telegram-video-'));    const maxBytes = config.VIDEO_MAX_SIZE_MB * 1024 * 1024;
    const height = config.VIDEO_MAX_HEIGHT;
    const httpTimeout = String(config.DOWNLOADER_HTTP_TIMEOUT_SECONDS);
    const retries = String(config.DOWNLOADER_RETRIES);
    const common = ['--ignore-config', '--no-playlist', '--no-cache-dir', '--no-progress',
      '--socket-timeout', httpTimeout, '--retries', retries, '--fragment-retries', retries,
      '--js-runtimes', 'node', '--use-extractors', config.VIDEO_EXTRACTORS,
      '--max-filesize', String(maxBytes),
      '--match-filter', `duration <=? ${config.VIDEO_MAX_DURATION_SECONDS} & !is_live`];
    // Validate metadata before downloading media. No cookies or authentication supplied.
    const metadata = JSON.parse(await run('yt-dlp', [...common, '--skip-download', '--dump-single-json', '--', source.url])) as VideoMetadata;
    validateVideoMetadata(metadata, config.VIDEO_MAX_DURATION_SECONDS);
    await run('yt-dlp', [...common, '--write-info-json', '--no-simulate',
      // Portrait Reels report height>720; sort near target res. ffmpeg remuxes to H.264.
      '-f', 'bv*+ba/b', '-S', `res:${height},+size`,
      '--merge-output-format', 'mp4', '-o', join(directory, 'source.%(ext)s'), '--', source.url]);
    const files = await readdir(directory);
    const info = JSON.parse(await readFile(join(directory, 'source.info.json'), 'utf8')) as VideoMetadata;
    validateVideoMetadata(info, config.VIDEO_MAX_DURATION_SECONDS);
    const media = files.filter((file) => /^source\.(mp4|webm|mkv|mov)$/.test(file));
    if (media.length !== 1) throw new Error('missing video');
    const input = join(directory, media[0]!);
    if ((await stat(input)).size > maxBytes) throw new Error('size');
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input]));
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > config.VIDEO_MAX_DURATION_SECONDS) throw new Error('duration');
    const output = join(directory, 'video.mp4');
    // Keep aspect ratio: limit the longer side, never stretch into a square.
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `scale='if(gte(iw\\,ih)\\,min(${height}\\,iw)\\,-2)':'if(lt(iw\\,ih)\\,min(${height}\\,ih)\\,-2)',setsar=1`,
      '-c:v', 'libx264', '-threads', String(config.VIDEO_FFMPEG_THREADS),
      '-preset', config.VIDEO_FFMPEG_PRESET, '-crf', String(config.VIDEO_FFMPEG_CRF), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', config.VIDEO_AUDIO_BITRATE, '-movflags', '+faststart',
      '-fs', String(maxBytes + 1), '-y', output]);
    const size = (await stat(output)).size;
    if (!size || size > maxBytes) throw new Error('size');
    const outputProbe = JSON.parse(await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration', '-of', 'json', output,
    ]));
    const outputDuration = Number(outputProbe.format?.duration);
    const outWidth = Number(outputProbe.streams?.[0]?.width);
    const outHeight = Number(outputProbe.streams?.[0]?.height);
    if (!Number.isFinite(outputDuration) || Math.abs(outputDuration - duration) > 1) throw new Error('incomplete video');
    if (!Number.isFinite(outWidth) || !Number.isFinite(outHeight) || outWidth < 2 || outHeight < 2) throw new Error('dimensions');
    // grammY declares the legacy node-fetch signal type; native Node signals work at runtime.
    const uploadSignal = AbortSignal.any([mediaSignal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
    const sent = await ctx.replyWithVideo(new InputFile(output), {
      ...reply,
      supports_streaming: true,
      width: outWidth,
      height: outHeight,
      duration: Math.round(outputDuration),
    }, uploadSignal as unknown as Parameters<Context['replyWithVideo']>[2]);
    await status.clear();
    const fileId = sent.video?.file_id;
    if (fileId) {
      await saveVideoCache(source.url, videoQualityKey(), {
        file_id: fileId,
        caption: '',
        width: outWidth,
        height: outHeight,
        duration: Math.round(outputDuration),
      }).catch(() => console.error('Video cache save failed'));
    }
  } catch {
    if (!mediaClosing()) {
      console.error('Video repost failed', { chatId: ctx.chat?.id, platform: source.platform });
      const errorText = `Не удалось загрузить ролик. Возможно, публикация закрыта, сервис ограничил доступ или превышены лимиты (${config.VIDEO_MAX_DURATION_SECONDS} сек., ${config.VIDEO_MAX_SIZE_MB} МБ).`;
      if (status) await status.fail(errorText);
      else await ctx.reply(errorText, reply).catch(() => {});
    }
  } finally {
    if (actionTimer) clearInterval(actionTimer);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => console.error('Video temp cleanup failed'));
  }
}

export async function maybeRepostVideo(ctx: Context) {
  if (!ctx.message?.text || !ctx.chat) return;
  const settings = await resolveChatSettings(ctx.chat.id);
  if (!settings.videoEnabled) return;
  const source = parseVideoLink(ctx.message.text);
  if (!source) return;
  const reply = { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
    ...(ctx.message.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}) };
  // Cache hits skip the download queue so repeats are instant.
  if (await sendCached(ctx, source, reply)) return;
  await enqueueMedia(ctx, () => repost(ctx, source), { cooldownSeconds: settings.mediaCooldownSeconds });
}

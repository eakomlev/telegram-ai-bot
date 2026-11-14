import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputFile, type Context } from 'grammy';
import { config } from './config.js';
import { runProcess } from './process.js';
import { parseVideoLink, validateVideoMetadata, videoCaption, type VideoMetadata } from './video-utils.js';

import { enqueueMedia, mediaSignal, mediaClosing } from './media-jobs.js';

async function repost(ctx: Context, source: NonNullable<ReturnType<typeof parseVideoLink>>) {
  let directory: string | undefined;
  const deadline = Date.now() + config.VIDEO_TIMEOUT_SECONDS * 1000;
  const run = (command: string, args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timeout');
    return runProcess(command, args, remaining, mediaSignal);
  };
  const reply = { reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true },
    ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}) };
  try {
    directory = await mkdtemp(join(tmpdir(), 'telegram-video-'));
    const maxBytes = config.VIDEO_MAX_SIZE_MB * 1024 * 1024;
    const common = ['--ignore-config', '--no-playlist', '--no-cache-dir', '--no-progress',
      '--socket-timeout', '15', '--retries', '1', '--fragment-retries', '1',
      '--js-runtimes', 'node', '--use-extractors', 'youtube.*,tiktok.*,vm.tiktok.*,instagram.*,vk.*',
      '--max-filesize', String(maxBytes), '--match-filter', `duration <= ${config.VIDEO_MAX_DURATION_SECONDS} & !is_live`];
    // Validate metadata before downloading media. No cookies or authentication supplied.
    const metadata = JSON.parse(await run('yt-dlp', [...common, '--skip-download', '--dump-single-json', '--', source.url])) as VideoMetadata;
    validateVideoMetadata(metadata, config.VIDEO_MAX_DURATION_SECONDS);
    await run('yt-dlp', [...common, '--write-info-json', '--no-simulate',
      '-f', 'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]',
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
    // Normalize for Telegram playback regardless of the platform's original codec.
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale=w='min(720,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-fs', String(maxBytes + 1), '-y', output]);
    const size = (await stat(output)).size;
    if (!size || size > maxBytes) throw new Error('size');
    const outputProbe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output]));
    const outputDuration = Number(outputProbe.format?.duration);
    if (!Number.isFinite(outputDuration) || Math.abs(outputDuration - duration) > 1) throw new Error('incomplete video');
    // grammY declares the legacy node-fetch signal type; native Node signals work at runtime.
    const uploadSignal = AbortSignal.any([mediaSignal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
    await ctx.replyWithVideo(new InputFile(output), { ...reply, caption: videoCaption(info, source), supports_streaming: true },
      uploadSignal as unknown as Parameters<Context['replyWithVideo']>[2]);
  } catch {
    if (!mediaClosing()) {
      console.error('Video repost failed', { chatId: ctx.chat?.id, platform: source.platform });
      await ctx.reply(`Не удалось загрузить ролик. Возможно, публикация закрыта, сервис ограничил доступ или превышены лимиты (${config.VIDEO_MAX_DURATION_SECONDS} сек., ${config.VIDEO_MAX_SIZE_MB} МБ).`, reply).catch(() => {});
    }
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => console.error('Video temp cleanup failed'));
  }
}

export async function maybeRepostVideo(ctx: Context) {
  if (config.VIDEO_ENABLED !== 'true' || !ctx.message?.text) return;
  const source = parseVideoLink(ctx.message.text);
  if (source) await enqueueMedia(ctx, () => repost(ctx, source));
}

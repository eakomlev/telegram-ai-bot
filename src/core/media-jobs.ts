import type { Context } from 'grammy';
import { config } from '../config.js';

const active = new Set<Promise<void>>();
const controller = new AbortController();
const recent = new Map<number, number>();
let closing = false;
export const mediaSignal = controller.signal;
export const mediaClosing = () => closing;

export async function enqueueMedia(
  ctx: Context,
  work: () => Promise<void>,
  options: { cooldownSeconds?: number } = {},
) {
  if (closing || !ctx.chat) return;
  const now = Date.now();
  const cooldown = options.cooldownSeconds ?? config.MEDIA_COOLDOWN_SECONDS ?? config.VIDEO_COOLDOWN_SECONDS;
  for (const [id, expiresAt] of recent) if (now >= expiresAt) recent.delete(id);
  if (recent.has(ctx.chat.id)) return;
  if (active.size >= (config.MEDIA_MAX_CONCURRENT ?? config.VIDEO_MAX_CONCURRENT)) {
    await ctx.reply('Загрузка медиа занята. Отправьте ссылку чуть позже.');
    return;
  }
  recent.set(ctx.chat.id, now + cooldown * 1000);
  const job = work();
  active.add(job);
  void job.then(() => active.delete(job), () => active.delete(job));
}

export async function stopMediaJobs() {
  closing = true;
  controller.abort();
  await Promise.allSettled(active);
}

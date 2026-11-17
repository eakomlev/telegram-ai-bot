import type { Context } from 'grammy';

/** Keep slow model requests out of sequential Telegram update processing. */
export class AiJobs {
  private readonly active = new Set<Promise<void>>();
  private readonly chats = new Set<number>();
  private closing = false;
  constructor(private readonly maxConcurrent = 3) {}

  start(chatId: number, work: () => Promise<void>): boolean {
    if (this.closing || this.chats.has(chatId) || this.active.size >= this.maxConcurrent) return false;
    this.chats.add(chatId);
    const job = Promise.resolve().then(work).catch(() => {
      console.error('Background AI request failed', { chatId });
    }).finally(() => { this.active.delete(job); this.chats.delete(chatId); });
    this.active.add(job);
    return true;
  }

  async stop() {
    this.closing = true;
    await Promise.allSettled(this.active);
  }
}

export const aiJobs = new AiJobs();
export async function enqueueAi(ctx: Context, work: () => Promise<void>) {
  if (!ctx.chat) return false;
  const accepted = aiJobs.start(ctx.chat.id, work);
  if (!accepted) {
    await ctx.reply('Сейчас обрабатываю другие запросы. Попробуйте чуть позже.').catch(() => {});
  }
  return accepted;
}

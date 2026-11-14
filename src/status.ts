import type { Context } from 'grammy';

type ReplyOpts = {
  reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
  message_thread_id?: number;
};

/** Temporary chat message shown while work runs; cleared before the real result or edited on failure. */
export async function startStatus(ctx: Context, text: string, reply: ReplyOpts = {}) {
  const chatId = ctx.chat?.id;
  let messageId: number | undefined;
  try {
    const sent = await ctx.reply(text, reply);
    messageId = sent.message_id;
  } catch {
    /* Status is best-effort; the main result still goes out. */
  }

  return {
    async clear() {
      if (chatId == null || messageId == null) return;
      await ctx.api.deleteMessage(chatId, messageId).catch(() => {});
      messageId = undefined;
    },
    async fail(errorText: string) {
      if (chatId != null && messageId != null) {
        try {
          await ctx.api.editMessageText(chatId, messageId, errorText);
          messageId = undefined;
          return;
        } catch { /* Fall through to a new reply. */ }
      }
      await ctx.reply(errorText, reply).catch(() => {});
    },
  };
}

export type StatusHandle = Awaited<ReturnType<typeof startStatus>>;

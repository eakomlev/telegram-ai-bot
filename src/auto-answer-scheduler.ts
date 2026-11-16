import type { Api } from 'grammy';
import { replyToUnansweredQuestion } from './ai.js';
import { resolveChatSettings } from './chat-settings.js';
import { allowedChatIds, config } from './config.js';
import {
  claimPendingAutoAnswer,
  isPendingAutoAnswerStillClaimed,
  listDuePendingAutoAnswers,
  markPendingAutoAnswerStatus,
  recordOpenAiUsage,
  type PendingAutoAnswer,
} from './db.js';
import { isPermanentTelegramDeliveryError } from './news-scheduler.js';

let autoAnswerTimer: NodeJS.Timeout | undefined;

export function autoAnswerClaimLeaseUntil(now = new Date()) {
  return new Date(now.getTime() + config.AUTO_ANSWER_CLAIM_LEASE_MS);
}

async function postAutoAnswer(api: Api, row: PendingAutoAnswer) {
  const settings = await resolveChatSettings(row.chatId);
  if (!settings.autoAnswerEnabled || config.AUTO_ANSWER_ENABLED !== 'true') {
    await markPendingAutoAnswerStatus(row.chatId, row.messageId, 'cancelled');
    return;
  }

  let text: string;
  let usage: Awaited<ReturnType<typeof replyToUnansweredQuestion>>['usage'];
  try {
    ({ text, usage } = await replyToUnansweredQuestion(row.questionText, row.author, settings.sarcasmLevel));
  } catch (error) {
    console.error('Auto-answer OpenAI failed', {
      chatId: row.chatId,
      messageId: row.messageId,
      message: error instanceof Error ? error.message : String(error),
    });
    await markPendingAutoAnswerStatus(row.chatId, row.messageId, 'failed');
    return;
  }

  // Engagement or settings toggle may have cancelled the row while the model ran.
  if (!(await isPendingAutoAnswerStillClaimed(row.chatId, row.messageId))) return;

  await recordOpenAiUsage(row.chatId, {
    kind: 'auto_answer',
    model: usage.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    imageCount: usage.imageCount,
    estimatedCostUsd: usage.estimatedCostUsd,
  }).catch(() => console.error('OpenAI usage record failed', { chatId: row.chatId, kind: 'auto_answer' }));

  const body = (text.trim() || ' ').slice(0, config.TELEGRAM_MAX_MESSAGE_LENGTH);
  try {
    await api.sendMessage(row.chatId, body, {
      reply_parameters: {
        message_id: row.messageId,
        allow_sending_without_reply: true,
      },
      ...(row.messageThreadId != null ? { message_thread_id: row.messageThreadId } : {}),
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    console.error('Auto-answer Telegram send failed', {
      chatId: row.chatId,
      messageId: row.messageId,
      message: error instanceof Error ? error.message : String(error),
    });
    if (isPermanentTelegramDeliveryError(error)) {
      await markPendingAutoAnswerStatus(row.chatId, row.messageId, 'failed');
      return;
    }
    // Leave claimed lease to expire; avoid tight retry loops on transient errors.
    return;
  }

  await markPendingAutoAnswerStatus(row.chatId, row.messageId, 'answered');
}

export async function runAutoAnswerSchedulerTick(api: Api, now = new Date()) {
  if (config.AUTO_ANSWER_ENABLED !== 'true') return;
  let due = await listDuePendingAutoAnswers(now);
  if (allowedChatIds.size) {
    due = due.filter((row) => allowedChatIds.has(String(row.chatId)));
  }
  for (const row of due) {
    const leaseUntil = autoAnswerClaimLeaseUntil(now);
    const claimed = await claimPendingAutoAnswer(row.chatId, row.messageId, leaseUntil, now);
    if (!claimed) continue;
    try {
      await postAutoAnswer(api, claimed);
    } catch (error) {
      console.error('Auto-answer tick item failed', {
        chatId: claimed.chatId,
        messageId: claimed.messageId,
        message: error instanceof Error ? error.message : String(error),
      });
      await markPendingAutoAnswerStatus(claimed.chatId, claimed.messageId, 'failed').catch(() => {});
    }
  }
}

export function startAutoAnswerScheduler(api: Api) {
  if (config.AUTO_ANSWER_ENABLED !== 'true') return;
  if (autoAnswerTimer) return;
  const tick = () => {
    void runAutoAnswerSchedulerTick(api).catch(() => console.error('Auto-answer scheduler tick failed'));
  };
  autoAnswerTimer = setInterval(tick, config.AUTO_ANSWER_TICK_INTERVAL_MS);
  autoAnswerTimer.unref();
  tick();
}

export function stopAutoAnswerScheduler() {
  if (!autoAnswerTimer) return;
  clearInterval(autoAnswerTimer);
  autoAnswerTimer = undefined;
}

import type { Api } from 'grammy';
import { replyToUnansweredQuestion } from './ai.js';
import { resolveChatSettings } from './chat-settings.js';
import { allowedChatIds, config } from './config.js';
import {
  claimPendingAutoAnswer,
  isCancelableAutoAnswerStatus,
  markPendingAutoAnswerSending,
  markPendingAutoAnswerStatus,
  markPendingAutoAnswerStatusWithClaim,
  markSendingAutoAnswerAnswered,
  markSendingAutoAnswerFailed,
  persistPendingAutoAnswerText,
  reclaimSendingAutoAnswerForSendRetry,
  listDuePendingAutoAnswers,
  recordOpenAiUsage,
  type PendingAutoAnswer,
} from './db.js';
import { isPermanentTelegramDeliveryError } from './news-scheduler.js';

let autoAnswerTimer: NodeJS.Timeout | undefined;

export function autoAnswerClaimLeaseUntil(now = new Date()) {
  return new Date(now.getTime() + config.AUTO_ANSWER_CLAIM_LEASE_MS);
}

/** Pure claim-token ownership check mirrored by SQL WHERE claimed_until = $lease. */
export function ownsAutoAnswerClaim(
  row: { status: string; claimedUntil: Date | null },
  lease: Date,
): boolean {
  return row.status === 'claimed'
    && row.claimedUntil != null
    && row.claimedUntil.getTime() === lease.getTime();
}

/** `sending` remains cancelable until Telegram ACK flips it to terminal `answered`. */
export function isSendableAutoAnswerStatus(status: string): boolean {
  return status === 'sending';
}

export { isCancelableAutoAnswerStatus };

/** Skip OpenAI when a previous attempt already persisted the answer. */
export function needsOpenAiGeneration(answerText: string | null | undefined) {
  return !answerText?.trim();
}

function claimLeaseOrThrow(row: PendingAutoAnswer): Date {
  if (!row.claimedUntil) throw new Error('Missing claim lease token');
  return row.claimedUntil;
}

async function ensureAnswerText(row: PendingAutoAnswer, lease: Date, sarcasmLevel: number): Promise<string | undefined> {
  if (!needsOpenAiGeneration(row.answerText)) return row.answerText!.trim();

  let text: string;
  let usage: Awaited<ReturnType<typeof replyToUnansweredQuestion>>['usage'];
  try {
    ({ text, usage } = await replyToUnansweredQuestion(row.questionText, row.author, sarcasmLevel));
  } catch (error) {
    console.error('Auto-answer OpenAI failed', {
      chatId: row.chatId,
      messageId: row.messageId,
      message: error instanceof Error ? error.message : String(error),
    });
    await markPendingAutoAnswerStatusWithClaim(row.chatId, row.messageId, lease, 'failed');
    return;
  }

  const body = (text.trim() || ' ').slice(0, config.TELEGRAM_MAX_MESSAGE_LENGTH);
  const saved = await persistPendingAutoAnswerText(row.chatId, row.messageId, lease, body);
  if (!saved) return; // cancelled or lease stolen while the model ran

  await recordOpenAiUsage(row.chatId, {
    kind: 'auto_answer',
    model: usage.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    imageCount: usage.imageCount,
    estimatedCostUsd: usage.estimatedCostUsd,
  }).catch(() => console.error('OpenAI usage record failed', { chatId: row.chatId, kind: 'auto_answer' }));

  return body;
}

async function postAutoAnswer(api: Api, row: PendingAutoAnswer, now: Date) {
  const lease = claimLeaseOrThrow(row);
  const settings = await resolveChatSettings(row.chatId);
  if (!settings.autoAnswerEnabled || config.AUTO_ANSWER_ENABLED !== 'true') {
    await markPendingAutoAnswerStatusWithClaim(row.chatId, row.messageId, lease, 'cancelled');
    return;
  }

  const answer = await ensureAnswerText(row, lease, settings.sarcasmLevel);
  if (!answer) return;

  // claimed → sending (still cancelable). Terminal answered only after Telegram ACK.
  const ready = await markPendingAutoAnswerSending(row.chatId, row.messageId, lease);
  if (ready == null) return;

  try {
    await api.sendMessage(row.chatId, ready, {
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
      const failed = await markSendingAutoAnswerFailed(row.chatId, row.messageId, lease);
      if (!failed) {
        console.error('Auto-answer permanent fail mark skipped (cancelled or lease lost)', {
          chatId: row.chatId,
          messageId: row.messageId,
        });
      }
      return;
    }
    // Send-only retry if still sending; human cancel wins and reclaim is a no-op.
    const reclaimed = await reclaimSendingAutoAnswerForSendRetry(
      row.chatId,
      row.messageId,
      lease,
      autoAnswerClaimLeaseUntil(now),
    );
    if (!reclaimed) {
      console.error('Auto-answer send retry reclaim skipped (cancelled or lease lost)', {
        chatId: row.chatId,
        messageId: row.messageId,
      });
    }
    return;
  }

  const answered = await markSendingAutoAnswerAnswered(row.chatId, row.messageId, lease);
  if (!answered) {
    // Ambiguous ACK vs cancel/timeout: do not reclaim — avoids double-deliver.
    console.error('Auto-answer mark-answered skipped after send (cancelled or lease lost)', {
      chatId: row.chatId,
      messageId: row.messageId,
    });
  }
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
      await postAutoAnswer(api, claimed, now);
    } catch (error) {
      console.error('Auto-answer tick item failed', {
        chatId: claimed.chatId,
        messageId: claimed.messageId,
        message: error instanceof Error ? error.message : String(error),
      });
      // Covers claimed and cancelable sending left mid-flight.
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

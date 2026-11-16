import type { Api } from 'grammy';
import { GrammyError } from 'grammy';
import { resolveChatSettings, type ChatSettings } from './chat-settings.js';
import { allowedChatIds, config } from './config.js';
import {
  claimNewsSend,
  disableNewsForChat,
  getChatSettingsRow,
  listDueNewsChats,
  markNewsSent,
  rescheduleNewsRun,
} from './db.js';
import { moscowDateString, moscowParts, pickRandomNewsRunAt, zonedMoscowTime } from './moscow-time.js';
import { postNewsToChat } from './news.js';

let newsTimer: NodeJS.Timeout | undefined;

const NEWS_CLAIM_LEASE_MS = 3 * 60_000;
const RESCHEDULE_ATTEMPTS = 3;

export function newsClaimLeaseUntil(now = new Date()) {
  return new Date(now.getTime() + NEWS_CLAIM_LEASE_MS);
}

export function nextDayNewsRunAt(now = new Date()) {
  const parts = moscowParts(now);
  const endOfWindow = zonedMoscowTime(parts.year, parts.month, parts.day, 21, 0);
  return pickRandomNewsRunAt(endOfWindow);
}

export function softRetryAt(now = new Date(), retryMinutes = config.NEWS_RETRY_MINUTES) {
  const parts = moscowParts(now);
  const endOfWindow = zonedMoscowTime(parts.year, parts.month, parts.day, 21, 0);
  const retry = new Date(now.getTime() + retryMinutes * 60_000);
  if (retry.getTime() < endOfWindow.getTime()) return retry;
  return nextDayNewsRunAt(now);
}

/** Permanent delivery failures: stop scheduling instead of burning OpenAI retries. */
export function isPermanentTelegramDeliveryError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code === 403) return true;
  const description = error.description.toLowerCase();
  return (
    description.includes('chat not found')
    || description.includes('bot was kicked')
    || description.includes('bot is not a member')
    || description.includes('group chat was upgraded')
  );
}

async function rescheduleNewsRunWithRetry(chatId: number, nextRunAt: Date) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESCHEDULE_ATTEMPTS; attempt += 1) {
    try {
      await rescheduleNewsRun(chatId, nextRunAt);
      return;
    } catch (error) {
      lastError = error;
      console.error('Daily news reschedule failed', {
        chatId,
        attempt,
        nextRunAt: nextRunAt.toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Lease remains claimable after expiry even if every reschedule attempt fails.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Ensure next_run is set when news is on with spheres; clear it when off or empty. Does not touch last_sent_on. */
export async function scheduleNewsIfNeeded(chatId: number, settings?: ChatSettings) {
  const resolved = settings ?? await resolveChatSettings(chatId);
  if (!resolved.newsEnabled || resolved.newsSpheres.length === 0) {
    await rescheduleNewsRun(chatId, null);
    return;
  }
  const row = await getChatSettingsRow(chatId);
  const now = new Date();
  const nextRun = row?.news_next_run_at ? new Date(row.news_next_run_at) : null;
  if (!nextRun || Number.isNaN(nextRun.getTime()) || nextRun.getTime() <= now.getTime()) {
    await rescheduleNewsRun(chatId, pickRandomNewsRunAt(now));
  }
}

export async function runNewsSchedulerTick(api: Api, now = new Date()) {
  if (config.NEWS_ENABLED !== 'true') return;
  let due = await listDueNewsChats(now);
  if (allowedChatIds.size) {
    due = due.filter((row) => allowedChatIds.has(String(row.chatId)));
  }
  const moscowDate = moscowDateString(now);
  for (const chat of due) {
    const leaseUntil = newsClaimLeaseUntil(now);
    const claimed = await claimNewsSend(chat.chatId, moscowDate, leaseUntil, now);
    if (!claimed) continue;
    try {
      await postNewsToChat(api, chat.chatId, claimed.newsSpheres);
      await markNewsSent(chat.chatId, moscowDate, nextDayNewsRunAt(now));
    } catch (error) {
      console.error('Daily news send failed', {
        chatId: chat.chatId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (isPermanentTelegramDeliveryError(error)) {
        try {
          await disableNewsForChat(chat.chatId);
        } catch (disableError) {
          console.error('Daily news disable failed', {
            chatId: chat.chatId,
            message: disableError instanceof Error ? disableError.message : String(disableError),
          });
        }
        continue;
      }
      try {
        await rescheduleNewsRunWithRetry(chat.chatId, softRetryAt(now));
      } catch {
        // next_run stays on the short claim lease and becomes due again after it expires
      }
    }
  }
}

export function startNewsScheduler(api: Api) {
  if (config.NEWS_ENABLED !== 'true') return;
  if (newsTimer) return;
  const tick = () => {
    void runNewsSchedulerTick(api).catch(() => console.error('News scheduler tick failed'));
  };
  newsTimer = setInterval(tick, config.NEWS_TICK_INTERVAL_MS);
  newsTimer.unref();
  tick();
}

export function stopNewsScheduler() {
  if (!newsTimer) return;
  clearInterval(newsTimer);
  newsTimer = undefined;
}

import type { Api } from 'grammy';
import { resolveChatSettings, type ChatSettings } from './chat-settings.js';
import { allowedChatIds, config } from './config.js';
import {
  claimNewsSend,
  getChatSettingsRow,
  listDueNewsChats,
  markNewsSent,
  rescheduleNewsRun,
} from './db.js';
import { moscowDateString, moscowParts, pickRandomNewsRunAt, zonedMoscowTime } from './moscow-time.js';
import { postNewsToChat } from './news.js';

let newsTimer: NodeJS.Timeout | undefined;

function nextDayNewsRunAt(now = new Date()) {
  const parts = moscowParts(now);
  const endOfWindow = zonedMoscowTime(parts.year, parts.month, parts.day, 21, 0);
  return pickRandomNewsRunAt(endOfWindow);
}

function softRetryAt(now = new Date()) {
  const parts = moscowParts(now);
  const endOfWindow = zonedMoscowTime(parts.year, parts.month, parts.day, 21, 0);
  const retry = new Date(now.getTime() + config.NEWS_RETRY_MINUTES * 60_000);
  if (retry.getTime() < endOfWindow.getTime()) return retry;
  return nextDayNewsRunAt(now);
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
    const nextRunAt = nextDayNewsRunAt(now);
    const claimed = await claimNewsSend(chat.chatId, moscowDate, nextRunAt);
    if (!claimed) continue;
    try {
      await postNewsToChat(api, chat.chatId, claimed.newsSpheres);
      await markNewsSent(chat.chatId, moscowDate);
    } catch (error) {
      console.error('Daily news send failed', {
        chatId: chat.chatId,
        message: error instanceof Error ? error.message : String(error),
      });
      await rescheduleNewsRun(chat.chatId, softRetryAt(now)).catch(() => {});
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

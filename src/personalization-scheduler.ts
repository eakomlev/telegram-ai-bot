import type { Api } from 'grammy';
import { allowedChatIds, config } from './config.js';
import {
  claimPersonalizationRun,
  clearPersonalizationRunClaim,
  listDuePersonalizationChats,
} from './db.js';
import { moscowDateString, moscowParts } from './moscow-time.js';
import {
  runPersonalizationForChat,
  shouldClearPersonalizationClaim,
  type PersonalizationRunResult,
} from './personalization.js';

let personalizationTimer: NodeJS.Timeout | undefined;
let runningTick: Promise<void> | undefined;

/** True when Moscow clock hour has reached the configured personalization hour. */
export function isPersonalizationHourDue(
  now = new Date(),
  hourMoscow = config.PERSONALIZATION_HOUR_MOSCOW,
): boolean {
  return moscowParts(now).hour >= hourMoscow;
}

/** Idempotency helper: a chat is due when last_run_on is missing or before today's Moscow date. */
export function isPersonalizationDayDue(
  lastRunOn: string | null | undefined,
  moscowDate: string,
): boolean {
  return !lastRunOn || lastRunOn < moscowDate;
}

/** After a claimed run: clear claim on thrown errors or empty productive results. */
export function shouldRetryPersonalizationClaim(
  result: PersonalizationRunResult | undefined,
  error?: unknown,
): boolean {
  return error != null || (result != null && shouldClearPersonalizationClaim(result));
}

export function runPersonalizationSchedulerTick(api: Api, now = new Date()): Promise<void> {
  if (runningTick) return runningTick;
  const job = runTick(api, now).finally(() => { runningTick = undefined; });
  runningTick = job;
  return job;
}

async function runTick(api: Api, now: Date) {
  if (config.PERSONALIZATION_ENABLED !== 'true') return;
  if (!isPersonalizationHourDue(now)) return;

  const moscowDate = moscowDateString(now);
  let due = await listDuePersonalizationChats(moscowDate);
  if (allowedChatIds.size) {
    due = due.filter((chatId) => allowedChatIds.has(String(chatId)));
  }

  for (const chatId of due) {
    const claimed = await claimPersonalizationRun(chatId, moscowDate);
    if (!claimed) continue;
    try {
      const result = await runPersonalizationForChat(chatId, { api, now });
      if (shouldRetryPersonalizationClaim(result)) {
        await clearPersonalizationRunClaim(chatId, moscowDate).catch((clearError) =>
          console.error('Personalization claim clear failed', {
            chatId,
            message: clearError instanceof Error ? clearError.message : String(clearError),
          }),
        );
      }
    } catch (error) {
      console.error('Personalization run failed', {
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (shouldRetryPersonalizationClaim(undefined, error)) {
        await clearPersonalizationRunClaim(chatId, moscowDate).catch((clearError) =>
          console.error('Personalization claim clear failed', {
            chatId,
            message: clearError instanceof Error ? clearError.message : String(clearError),
          }),
        );
      }
    }
  }
}

export function startPersonalizationScheduler(api: Api) {
  if (config.PERSONALIZATION_ENABLED !== 'true') return;
  if (personalizationTimer) return;
  const tick = () => {
    void runPersonalizationSchedulerTick(api).catch(() =>
      console.error('Personalization scheduler tick failed'),
    );
  };
  personalizationTimer = setInterval(tick, config.PERSONALIZATION_TICK_INTERVAL_MS);
  personalizationTimer.unref();
  tick();
}

export async function stopPersonalizationScheduler() {
  if (personalizationTimer) clearInterval(personalizationTimer);
  personalizationTimer = undefined;
  await runningTick;
}

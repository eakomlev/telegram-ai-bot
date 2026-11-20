import type { Api } from 'grammy';
import { GrammyError } from 'grammy';
import { chatGcHoursMoscow, config } from '../config.js';
import { listKnownChatIds, purgeChatData } from '../core/db.js';
import { moscowDateString, moscowParts } from '../core/moscow-time.js';
import { isChatUpgradeError, isPermanentTelegramDeliveryError } from './telegram-errors.js';

let chatGcTimer: NodeJS.Timeout | undefined;
let runningTick: Promise<void> | undefined;
/** Last successfully finished `(moscowDate, hour)` slot; skipped on later ticks in the same hour. */
let lastCompletedSlot: string | undefined;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slotKey(now: Date): string {
  const parts = moscowParts(now);
  return `${moscowDateString(now)}:${parts.hour}`;
}

/** True when the current Moscow hour is in the configured GC hours set. */
export function isChatGcHourDue(
  now = new Date(),
  hours: ReadonlySet<number> = chatGcHoursMoscow,
): boolean {
  return hours.has(moscowParts(now).hour);
}

export function runChatGcSchedulerTick(api: Api, now = new Date()): Promise<void> {
  if (runningTick) return runningTick;
  const job = runTick(api, now).finally(() => { runningTick = undefined; });
  runningTick = job;
  return job;
}

async function runTick(api: Api, now: Date) {
  if (config.CHAT_GC_ENABLED !== 'true') return;
  if (!isChatGcHourDue(now)) return;

  const slot = slotKey(now);
  if (lastCompletedSlot === slot) return;

  // Probe all known ids (ignore ALLOWED_CHAT_IDS). Skip positive private-chat ids.
  let chatIds = await listKnownChatIds();
  chatIds = chatIds.filter((id) => id < 0);

  let abortedByRateLimit = false;
  let purgeFailed = false;
  for (const chatId of chatIds) {
    try {
      await api.getChat(chatId);
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) {
        console.error('Chat GC rate limited; aborting remaining probes', {
          chatId,
          message: error.description,
        });
        abortedByRateLimit = true;
        break;
      }
      const upgrade = isChatUpgradeError(error);
      if (upgrade || isPermanentTelegramDeliveryError(error)) {
        if (upgrade) {
          console.error('Chat GC purging old id after group→supergroup upgrade', {
            chatId,
            migrateToChatId: error instanceof GrammyError
              ? error.parameters?.migrate_to_chat_id
              : undefined,
            message: error instanceof Error ? error.message : String(error),
          });
        } else {
          console.error('Chat GC purging inaccessible chat', {
            chatId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          await purgeChatData(chatId);
        } catch (purgeError) {
          purgeFailed = true;
          console.error('Chat GC purge failed', {
            chatId,
            message: purgeError instanceof Error ? purgeError.message : String(purgeError),
          });
        }
      } else {
        console.error('Chat GC probe failed', {
          chatId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (config.CHAT_GC_PROBE_DELAY_MS > 0) {
      await sleep(config.CHAT_GC_PROBE_DELAY_MS);
    }
  }

  // Mark slot complete only after a full pass; 429 / purge failure leave it open for retry.
  if (!abortedByRateLimit && !purgeFailed) {
    lastCompletedSlot = slot;
  }
}

export function startChatGcScheduler(api: Api) {
  if (config.CHAT_GC_ENABLED !== 'true') return;
  if (chatGcTimer) return;
  const tick = () => {
    void runChatGcSchedulerTick(api).catch(() => console.error('Chat GC scheduler tick failed'));
  };
  chatGcTimer = setInterval(tick, config.CHAT_GC_TICK_INTERVAL_MS);
  chatGcTimer.unref();
  tick();
}

export async function stopChatGcScheduler() {
  if (chatGcTimer) clearInterval(chatGcTimer);
  chatGcTimer = undefined;
  await runningTick;
  lastCompletedSlot = undefined;
}

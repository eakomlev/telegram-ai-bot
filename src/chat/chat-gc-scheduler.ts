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

export type ChatGcPurgeKind = 'gone' | 'upgrade';

export type ChatGcReport = {
  candidates: number;
  checked: number;
  alive: number;
  purged: Array<{ chatId: number; kind: ChatGcPurgeKind }>;
  probeErrors: number[];
  purgeErrors: number[];
  rateLimited: boolean;
};

export type ChatGcManualResult = ChatGcReport | 'busy' | 'disabled';

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

function passCompleted(report: ChatGcReport): boolean {
  return !report.rateLimited && report.purgeErrors.length === 0;
}

/**
 * `getChat` still succeeds for a deleted basic group: the Bot API only refuses
 * member-list reads (`getChatMemberCount`) with "the group chat was deleted".
 * A chat counts as alive only when that second call succeeds.
 */
async function probeOneChat(api: Api, chatId: number, report: ChatGcReport): Promise<'continue' | 'stop'> {
  try {
    await api.getChat(chatId);
  } catch (error) {
    return applyProbeError(chatId, error, report);
  }
  try {
    const memberCount = await api.getChatMemberCount(chatId);
    if (!Number.isFinite(memberCount) || memberCount < 0) {
      report.probeErrors.push(chatId);
      console.error('Chat GC probe failed', { chatId, message: 'member count is not a number' });
      return 'continue';
    }
    report.alive += 1;
    return 'continue';
  } catch (error) {
    return applyProbeError(chatId, error, report);
  }
}

async function applyProbeError(chatId: number, error: unknown, report: ChatGcReport): Promise<'continue' | 'stop'> {
  if (error instanceof GrammyError && error.error_code === 429) {
    console.error('Chat GC rate limited; aborting remaining probes', {
      chatId,
      message: error.description,
    });
    report.rateLimited = true;
    return 'stop';
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
    return purgeProbedChat(chatId, upgrade ? 'upgrade' : 'gone', report);
  }
  report.probeErrors.push(chatId);
  console.error('Chat GC probe failed', {
    chatId,
    message: error instanceof Error ? error.message : String(error),
  });
  return 'continue';
}

function purgeProbedChat(
  chatId: number,
  kind: ChatGcPurgeKind,
  report: ChatGcReport,
): Promise<'continue'> {
  return purgeChatData(chatId).then(
    () => {
      report.purged.push({ chatId, kind });
      return 'continue' as const;
    },
    (purgeError: unknown) => {
      report.purgeErrors.push(chatId);
      console.error('Chat GC purge failed', {
        chatId,
        message: purgeError instanceof Error ? purgeError.message : String(purgeError),
      });
      return 'continue' as const;
    },
  );
}

/** Probe every known group. Positive private ids are skipped. Allowlist is ignored. */
export async function probeKnownChats(api: Api): Promise<ChatGcReport> {
  let chatIds = await listKnownChatIds();
  chatIds = chatIds.filter((id) => id < 0);
  const report: ChatGcReport = {
    candidates: chatIds.length,
    checked: 0,
    alive: 0,
    purged: [],
    probeErrors: [],
    purgeErrors: [],
    rateLimited: false,
  };

  for (const chatId of chatIds) {
    report.checked += 1;
    const outcome = await probeOneChat(api, chatId, report);
    if (outcome === 'stop') break;
    if (config.CHAT_GC_PROBE_DELAY_MS > 0) {
      await sleep(config.CHAT_GC_PROBE_DELAY_MS);
    }
  }

  return report;
}

async function runTick(api: Api, now: Date) {
  if (config.CHAT_GC_ENABLED !== 'true') return;
  if (!isChatGcHourDue(now)) return;

  const slot = slotKey(now);
  if (lastCompletedSlot === slot) return;

  const report = await probeKnownChats(api);
  // Mark slot complete only after a full pass; 429 / purge failure leave it open for retry.
  if (passCompleted(report)) lastCompletedSlot = slot;
}

/**
 * Owner command: same probe as the scheduler, at any hour.
 * A finished pass counts as this Moscow hour's slot, so the timer does not repeat it.
 */
export function runChatGcNow(api: Api, now = new Date()): Promise<ChatGcManualResult> {
  if (config.CHAT_GC_ENABLED !== 'true') return Promise.resolve('disabled');
  if (runningTick) return Promise.resolve('busy');
  const settled = probeKnownChats(api).then((report) => {
    if (passCompleted(report)) lastCompletedSlot = slotKey(now);
    return report;
  });
  const job = settled.finally(() => { runningTick = undefined; });
  runningTick = job.then(() => undefined, () => undefined);
  return job;
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

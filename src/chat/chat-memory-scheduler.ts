import { mergeChatMemory } from '../ai/ai.js';
import { formatContextLine } from './chat-context.js';
import {
  computeChatMemoryClaimLeaseMs,
  isChatMemoryHourDue,
  shouldSoftSkipChatMemory,
} from './chat-memory.js';
import { allowedChatIds, config } from '../config.js';
import {
  claimChatMemory,
  completeChatMemory,
  countHumanMessagesSince,
  getChatMemory,
  listChatMemoryCandidates,
  markChatMemorySoftSkipped,
  recordOpenAiUsage,
  selectMessagesForChatMemory,
} from '../core/db.js';
import { moscowDateString } from '../core/moscow-time.js';
import { truncateText } from '../summary/summary.js';

let memoryTimer: NodeJS.Timeout | undefined;
let runningTick: Promise<void> | undefined;

export function runChatMemorySchedulerTick(now = new Date()): Promise<void> {
  if (runningTick) return runningTick;
  const startedAt = Date.now();
  const clock = () => new Date(now.getTime() + Date.now() - startedAt);
  const job = runTick(now, clock).finally(() => { runningTick = undefined; });
  runningTick = job;
  return job;
}

async function runTick(now: Date, clock: () => Date) {
  if (config.CHAT_MEMORY_ENABLED !== 'true') return;
  if (!isChatMemoryHourDue(now, config.CHAT_MEMORY_HOUR_MOSCOW)) return;

  let chats = await listChatMemoryCandidates(now);
  if (allowedChatIds.size) {
    chats = chats.filter((chatId) => allowedChatIds.has(String(chatId)));
  }

  for (const chatId of chats) {
    const claimedAt = clock();
    const moscowDate = moscowDateString(claimedAt);
    const leaseUntil = new Date(claimedAt.getTime() + computeChatMemoryClaimLeaseMs(
      config.OPENAI_TIMEOUT_MS,
      config.OPENAI_MAX_RETRIES,
    ));
    const claimed = await claimChatMemory(chatId, moscowDate, leaseUntil, claimedAt);
    if (!claimed) continue;
    try {
      await mergeOneChat(chatId, claimedAt, moscowDate, leaseUntil);
    } catch (error) {
      console.error('Chat memory update failed', {
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function mergeOneChat(chatId: number, claimedAt: Date, moscowDate: string, leaseUntil: Date) {
  const since = new Date(claimedAt.getTime() - config.CHAT_MEMORY_LOOKBACK_HOURS * 60 * 60 * 1000);
  const humanCount = await countHumanMessagesSince(chatId, since);
  if (shouldSoftSkipChatMemory(humanCount)) {
    await markChatMemorySoftSkipped(chatId, moscowDate, leaseUntil);
    return;
  }

  const newestFirst = await selectMessagesForChatMemory({
    chatId,
    since,
    limit: config.CHAT_MEMORY_MAX_MESSAGES,
  });
  const chronological = [...newestFirst].reverse();
  const lines = chronological.map((row) => formatContextLine({ author: row.author, text: row.text }));
  const previous = await getChatMemory(chatId);
  const { text, usage } = await mergeChatMemory({
    previousBody: previous.body,
    transcript: lines,
    lookbackHours: config.CHAT_MEMORY_LOOKBACK_HOURS,
  });
  if (!text.trim()) return;

  const newest = chronological[chronological.length - 1];
  const saved = await completeChatMemory({
    chatId,
    body: truncateText(text, config.CHAT_MEMORY_MAX_INPUT_CHARS),
    sourceUntil: newest?.sent_at ?? null,
    moscowDate,
    leaseUntil,
  });
  if (!saved) return;
  await recordOpenAiUsage(chatId, {
    kind: 'chat_memory',
    model: usage.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    imageCount: usage.imageCount,
    estimatedCostUsd: usage.estimatedCostUsd,
  }).catch((error) => {
    console.error('OpenAI usage record failed', {
      chatId,
      kind: 'chat_memory',
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export function startChatMemoryScheduler(): void {
  if (config.CHAT_MEMORY_ENABLED !== 'true') return;
  if (memoryTimer) return;
  const tick = () => {
    void runChatMemorySchedulerTick().catch(() => console.error('Chat memory scheduler tick failed'));
  };
  memoryTimer = setInterval(tick, config.CHAT_MEMORY_TICK_INTERVAL_MS);
  memoryTimer.unref();
  tick();
}

export async function stopChatMemoryScheduler(): Promise<void> {
  if (memoryTimer) clearInterval(memoryTimer);
  memoryTimer = undefined;
  await runningTick;
}

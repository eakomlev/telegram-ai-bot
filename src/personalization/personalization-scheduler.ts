import type { Api } from 'grammy';
import { allowedChatIds, config } from '../config.js';
import {
  claimPersonalizationRun,
  clearPersonalizationRunClaim,
  getChatSettingsRow,
  listDuePersonalizationChats,
  listEnabledPersonalizationChats,
  markPersonalizationRun,
} from '../core/db.js';
import { moscowDateString, moscowParts } from '../core/moscow-time.js';
import {
  runPersonalizationForChat,
  shouldClearPersonalizationClaim,
  type PersonalizationRunResult,
} from './personalization.js';

let personalizationTimer: NodeJS.Timeout | undefined;
let runningTick: Promise<void> | undefined;

export class PersonalizationBusyError extends Error {
  constructor(message = 'Personalization already in progress') {
    super(message);
    this.name = 'PersonalizationBusyError';
  }
}

/** True while a scheduler tick or manual run holds the in-process mutex. */
export function isPersonalizationRunInProgress(): boolean {
  return runningTick != null;
}

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

export type ManualPersonalizationOptions = {
  /** If omitted → all enabled chats (plus ALLOWED_CHAT_IDS filter). */
  chatIds?: number[];
  now?: Date;
};

export type ManualPersonalizationChatResult = {
  chatId: number;
  skipped: boolean;
  reason?: string;
  updated: number;
  error?: string;
};

/**
 * Owner-triggered personalization: ignores Moscow hour and same-day claim.
 * Shares `runningTick` with the nightly scheduler so OpenAI runs never overlap.
 */
export async function runManualPersonalization(
  api: Api,
  options: ManualPersonalizationOptions = {},
): Promise<ManualPersonalizationChatResult[]> {
  if (runningTick) throw new PersonalizationBusyError();

  let results: ManualPersonalizationChatResult[] = [];
  const job = (async () => {
    results = await runManual(api, options);
  })().finally(() => {
    runningTick = undefined;
  });
  runningTick = job;
  await job;
  return results;
}

async function runManual(
  api: Api,
  options: ManualPersonalizationOptions,
): Promise<ManualPersonalizationChatResult[]> {
  if (config.PERSONALIZATION_ENABLED !== 'true') return [];

  const now = options.now ?? new Date();
  const moscowDate = moscowDateString(now);
  const enabled = new Set(await listEnabledPersonalizationChats());
  let chatIds = options.chatIds ? options.chatIds.filter((id) => enabled.has(id)) : [...enabled];
  if (allowedChatIds.size) {
    chatIds = chatIds.filter((chatId) => allowedChatIds.has(String(chatId)));
  }

  const results: ManualPersonalizationChatResult[] = [];
  for (const chatId of chatIds) {
    try {
      const result = await runPersonalizationForChat(chatId, { api, now });
      await markPersonalizationRun(chatId, moscowDate).catch((markError) =>
        console.error('Personalization mark failed', {
          chatId,
          message: markError instanceof Error ? markError.message : String(markError),
        }),
      );
      results.push({
        chatId,
        skipped: result.skipped,
        reason: result.reason,
        updated: result.updated,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Manual personalization run failed', { chatId, message });
      results.push({
        chatId,
        skipped: false,
        updated: 0,
        error: message,
      });
    }
  }
  return results;
}

/** Russian summary for owner `/personalize` reply. */
export function formatManualPersonalizationSummary(
  results: ManualPersonalizationChatResult[],
): string {
  if (!results.length) {
    return 'Нет чатов для персонализации (проверьте флаги и ALLOWED_CHAT_IDS).';
  }
  const lines = ['Персонализация завершена:'];
  let updatedTotal = 0;
  let skipped = 0;
  let errors = 0;
  for (const row of results) {
    if (row.error) {
      errors += 1;
      lines.push(`• ${row.chatId}: ошибка — ${row.error}`);
      continue;
    }
    if (row.skipped) {
      skipped += 1;
      lines.push(`• ${row.chatId}: пропуск${row.reason ? ` (${row.reason})` : ''}`);
      continue;
    }
    updatedTotal += row.updated;
    lines.push(`• ${row.chatId}: обновлено ${row.updated}`);
  }
  lines.push(
    '',
    `Чатов: ${results.length}, обновлено участников: ${updatedTotal}, пропусков: ${skipped}, ошибок: ${errors}.`,
  );
  return lines.join('\n');
}

/** Parse optional `/personalize` argument: undefined = all, number = one chat, null = invalid. */
export function parsePersonalizeChatIdArg(raw: string): number | undefined | null {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

export type PersonalizeChatIneligibleReason = 'not_allowed' | 'unknown' | 'disabled';

/** Russian error for `/personalize <chat_id>` when the target would be filtered out. */
export function formatPersonalizeChatIneligibleMessage(
  chatId: number,
  reason: PersonalizeChatIneligibleReason,
): string {
  switch (reason) {
    case 'not_allowed':
      return `Чат ${chatId} не входит в ALLOWED_CHAT_IDS.`;
    case 'unknown':
      return `Чат ${chatId} неизвестен боту (нет настроек).`;
    case 'disabled':
      return `В чате ${chatId} персонализация выключена.`;
  }
}

/**
 * If `/personalize <chat_id>` would yield an empty run after enable/allowlist filters,
 * return an explicit Russian error; otherwise undefined (eligible).
 */
export async function getManualPersonalizationChatBlockReason(
  chatId: number,
): Promise<string | undefined> {
  if (allowedChatIds.size && !allowedChatIds.has(String(chatId))) {
    return formatPersonalizeChatIneligibleMessage(chatId, 'not_allowed');
  }
  const row = await getChatSettingsRow(chatId);
  if (!row) {
    return formatPersonalizeChatIneligibleMessage(chatId, 'unknown');
  }
  if (!row.personalization_enabled) {
    return formatPersonalizeChatIneligibleMessage(chatId, 'disabled');
  }
  return undefined;
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

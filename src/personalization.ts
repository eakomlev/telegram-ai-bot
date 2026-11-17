import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  draftParticipantCharacteristics,
  mergeParticipantCharacteristic,
} from './ai.js';
import { config } from './config.js';
import {
  getLatestMemberCount,
  listChatParticipants,
  listMessagesForPersonalization,
  recordOpenAiUsage,
  saveChatMemberSnapshot,
  updateParticipantCharacteristic,
  type PersonalizationMessage,
} from './db.js';
import type { Api } from 'grammy';

const DATA_ROOT = path.join(process.cwd(), 'data', 'personalization');

export function personalizationChatDir(chatId: number) {
  return path.join(DATA_ROOT, String(chatId));
}

export function personalizationDraftPath(chatId: number, userId: number) {
  return path.join(personalizationChatDir(chatId), `${userId}.txt`);
}

/** Format one transcript line as `[userId|displayName]: text`. */
export function formatTranscriptLine(message: {
  authorUserId: number;
  displayName: string;
  text: string;
}): string {
  const name = message.displayName.replace(/[\r\n]+/g, ' ').trim() || 'Участник';
  const text = message.text.replace(/\r\n/g, '\n').trim();
  return `[${message.authorUserId}|${name}]: ${text}`;
}

export function buildPersonalizationTranscript(messages: PersonalizationMessage[]): string {
  return messages.map(formatTranscriptLine).join('\n');
}

export function isChatMemberCountEligible(
  memberCount: number | undefined | null,
  maxMembers = config.PERSONALIZATION_MAX_CHAT_MEMBERS,
): boolean {
  if (memberCount == null || !Number.isFinite(memberCount)) return true;
  return memberCount < maxMembers;
}

/** Split transcript into chunks that fit PERSONALIZATION_MAX_INPUT_CHARS (by whole lines). */
export function chunkTranscriptByChars(
  transcript: string,
  maxChars = config.PERSONALIZATION_MAX_INPUT_CHARS,
): string[] {
  const lines = transcript.split('\n').filter((line) => line.length > 0);
  if (!lines.length) return [];
  const chunks: string[] = [];
  let current: string[] = [];
  let used = 0;
  for (const line of lines) {
    const extra = line.length + (current.length ? 1 : 0);
    if (current.length && used + extra > maxChars) {
      chunks.push(current.join('\n'));
      current = [];
      used = 0;
    }
    if (line.length > maxChars && current.length === 0) {
      chunks.push(line.slice(0, maxChars));
      continue;
    }
    current.push(line);
    used += extra;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

export function batchParticipants<T>(items: T[], batchSize = config.PERSONALIZATION_BATCH_USERS): T[][] {
  const size = Math.max(1, batchSize);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function ensureChatDir(chatId: number) {
  await mkdir(personalizationChatDir(chatId), { recursive: true });
}

export async function writeDraftFiles(
  chatId: number,
  drafts: Map<number, string>,
): Promise<void> {
  if (!drafts.size) return;
  await ensureChatDir(chatId);
  for (const [userId, draft] of drafts) {
    const filePath = personalizationDraftPath(chatId, userId);
    let previous = '';
    try {
      previous = await readFile(filePath, 'utf8');
    } catch {
      // first draft for this user in the run
    }
    const next = previous.trim()
      ? `${previous.trim()}\n\n${draft.trim()}`
      : draft.trim();
    await writeFile(filePath, next, 'utf8');
  }
}

export async function readDraftFile(chatId: number, userId: number): Promise<string | undefined> {
  try {
    const text = await readFile(personalizationDraftPath(chatId, userId), 'utf8');
    const trimmed = text.trim();
    return trimmed || undefined;
  } catch {
    return;
  }
}

export async function deleteDraftFile(chatId: number, userId: number): Promise<void> {
  try {
    await unlink(personalizationDraftPath(chatId, userId));
  } catch {
    // already gone
  }
}

/** Remove leftover draft files for users not in keepUserIds (and empty chat dirs). */
export async function cleanupStaleDraftFiles(
  chatId: number,
  keepUserIds: Iterable<number>,
): Promise<void> {
  const keep = new Set([...keepUserIds].map(String));
  const dir = personalizationChatDir(chatId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.txt')) continue;
    const id = entry.slice(0, -4);
    if (keep.has(id)) continue;
    try {
      await unlink(path.join(dir, entry));
    } catch {
      // ignore
    }
  }
  try {
    const left = await readdir(dir);
    if (left.length === 0) await rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export async function resolveChatMemberCount(
  api: Api | undefined,
  chatId: number,
): Promise<number | undefined> {
  const cached = await getLatestMemberCount(chatId);
  if (cached != null) return cached;
  if (!api) return;
  try {
    const count = await api.getChatMemberCount(chatId);
    if (!Number.isFinite(count) || count < 0) return;
    const memberCount = Math.floor(count);
    const capturedOn = new Date().toISOString().slice(0, 10);
    await saveChatMemberSnapshot(chatId, capturedOn, memberCount).catch(() => {});
    return memberCount;
  } catch (error) {
    console.error('Personalization member count fetch failed', {
      chatId,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

async function addUsage(
  chatId: number,
  usage: { model: string; promptTokens: number; completionTokens: number; imageCount: number; estimatedCostUsd: number },
) {
  await recordOpenAiUsage(chatId, {
    kind: 'personalization',
    model: usage.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    imageCount: usage.imageCount,
    estimatedCostUsd: usage.estimatedCostUsd,
  }).catch(() => console.error('OpenAI usage record failed', { chatId, kind: 'personalization' }));
}

/**
 * Full-day dump → OpenAI drafts (with chunk/batch fallback) → txt files →
 * per-user merge into DB → delete successful txts.
 */
export async function runPersonalizationForChat(
  chatId: number,
  options: { api?: Api; now?: Date } = {},
): Promise<{ skipped: boolean; reason?: string; updated: number }> {
  const now = options.now ?? new Date();
  const memberCount = await resolveChatMemberCount(options.api, chatId);
  if (!isChatMemberCountEligible(memberCount)) {
    await cleanupStaleDraftFiles(chatId, []);
    return { skipped: true, reason: 'member_count', updated: 0 };
  }

  const until = now;
  const since = new Date(now.getTime() - config.PERSONALIZATION_LOOKBACK_HOURS * 60 * 60 * 1000);
  const messages = await listMessagesForPersonalization({
    chatId,
    since,
    until,
    maxMessages: config.PERSONALIZATION_MAX_MESSAGES,
  });
  const participants = await listChatParticipants(chatId, config.PERSONALIZATION_MAX_USERS_PER_CHAT);
  if (!participants.length) {
    return { skipped: true, reason: 'no_participants', updated: 0 };
  }

  const activeIds = new Set(messages.map((m) => m.authorUserId));
  const targets = participants.filter((p) => activeIds.has(p.userId));
  const workList = targets.length ? targets : participants.slice(0, config.PERSONALIZATION_BATCH_USERS);
  if (!messages.length) {
    await cleanupStaleDraftFiles(chatId, []);
    return { skipped: true, reason: 'no_messages', updated: 0 };
  }

  const transcript = buildPersonalizationTranscript(messages);
  const chunks = chunkTranscriptByChars(transcript);
  const userBatches = batchParticipants(
    workList.map((p) => ({ userId: p.userId, displayName: p.displayName })),
  );

  const needsBatching =
    chunks.length > 1
    || userBatches.length > 1
    || transcript.length > config.PERSONALIZATION_MAX_INPUT_CHARS;

  try {
    if (!needsBatching) {
      const { drafts, usage } = await draftParticipantCharacteristics({
        transcript,
        participants: workList.map((p) => ({ userId: p.userId, displayName: p.displayName })),
      });
      await addUsage(chatId, usage);
      await writeDraftFiles(chatId, drafts);
    } else {
      for (const chunk of chunks.length ? chunks : ['']) {
        for (const batch of userBatches) {
          const { drafts, usage } = await draftParticipantCharacteristics({
            transcript: chunk,
            participants: batch,
          });
          await addUsage(chatId, usage);
          await writeDraftFiles(chatId, drafts);
        }
      }
    }
  } catch (error) {
    console.error('Personalization draft failed', {
      chatId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  let updated = 0;
  for (const participant of workList) {
    const draft = await readDraftFile(chatId, participant.userId);
    if (!draft) continue;
    try {
      const { characteristic, usage } = await mergeParticipantCharacteristic({
        previous: participant.characteristic,
        draft,
        displayName: participant.displayName,
      });
      await addUsage(chatId, usage);
      await updateParticipantCharacteristic({
        chatId,
        userId: participant.userId,
        characteristic,
        sourceUntil: until,
      });
      await deleteDraftFile(chatId, participant.userId);
      updated += 1;
    } catch (error) {
      console.error('Personalization merge failed', {
        chatId,
        userId: participant.userId,
        message: error instanceof Error ? error.message : String(error),
      });
      // leave txt for next run overwrite
    }
  }

  // Keep only drafts that still need a merge retry; drop stale leftovers.
  const keepFailed: number[] = [];
  for (const participant of workList) {
    if (await readDraftFile(chatId, participant.userId)) keepFailed.push(participant.userId);
  }
  await cleanupStaleDraftFiles(chatId, keepFailed);

  return { skipped: false, updated };
}

import type { Api } from 'grammy';
import { allowedChatIds } from '../config.js';
import {
  hasChatMemberSnapshot,
  listKnownChatIds,
  saveChatMemberSnapshot,
} from '../core/db.js';

function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Once per UTC day, snapshot Telegram member counts for known groups. */
export async function runDailyMemberSnapshots(api: Api) {
  const capturedOn = utcDateString();
  let chatIds = await listKnownChatIds();
  if (allowedChatIds.size) {
    chatIds = chatIds.filter((id) => allowedChatIds.has(String(id)));
  }
  for (const chatId of chatIds) {
    if (await hasChatMemberSnapshot(chatId, capturedOn)) continue;
    try {
      const memberCount = await api.getChatMemberCount(chatId);
      if (!Number.isFinite(memberCount) || memberCount < 0) continue;
      await saveChatMemberSnapshot(chatId, capturedOn, Math.floor(memberCount));
    } catch (error) {
      console.error('Chat member snapshot failed', {
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(75);
  }
}

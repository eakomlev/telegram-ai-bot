import type { Api } from 'grammy';
import { generateInterestingNews } from '../ai/ai.js';
import { formatChatMemoryBlock } from '../chat/chat-memory.js';
import { config } from '../config.js';
import { getChatMemory, recordOpenAiUsage } from '../core/db.js';

export async function newsMemoryBlock(chatId: number): Promise<string> {
  const memory = await getChatMemory(chatId);
  return formatChatMemoryBlock({
    body: memory.body,
    pinned: memory.pinned,
    bodyMaxChars: config.CHAT_MEMORY_PROMPT_MAX_CHARS,
    pinMaxChars: config.CHAT_MEMORY_PIN_MAX_CHARS,
  });
}

async function composeNews(chatId: number): Promise<{ status: 'empty' } | { status: 'ok'; text: string }> {
  const memoryBlock = await newsMemoryBlock(chatId);
  if (!memoryBlock.trim()) return { status: 'empty' };
  const { text, usage } = await generateInterestingNews(memoryBlock);
  await recordOpenAiUsage(chatId, {
    kind: 'news',
    model: usage.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    imageCount: usage.imageCount,
    estimatedCostUsd: usage.estimatedCostUsd,
  }).catch(() => console.error('OpenAI usage record failed', { chatId, kind: 'news' }));
  const body = (text.trim() || ' ').slice(0, config.TELEGRAM_MAX_MESSAGE_LENGTH);
  return { status: 'ok', text: body };
}

/** Daily post into the group. Empty memory does not call the model and does not send. */
export async function postNewsToChat(api: Api, chatId: number): Promise<'sent' | 'empty'> {
  const composed = await composeNews(chatId);
  if (composed.status === 'empty') return 'empty';
  await api.sendMessage(chatId, composed.text, { link_preview_options: { is_disabled: true } });
  return 'sent';
}

const previewInFlight = new Set<number>();

/** Owner preview: same generation, no message to the group. */
export async function previewNews(
  chatId: number,
): Promise<{ status: 'empty' | 'busy' } | { status: 'ok'; text: string }> {
  if (previewInFlight.has(chatId)) return { status: 'busy' };
  previewInFlight.add(chatId);
  try {
    return await composeNews(chatId);
  } finally {
    previewInFlight.delete(chatId);
  }
}

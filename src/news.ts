import type { Api } from 'grammy';
import { generateInterestingNews } from './ai.js';
import { config } from './config.js';
import { recordOpenAiUsage } from './db.js';
import { pickRandomSphere, sanitizeSpheres, sphereLabel } from './news-spheres.js';

export async function postNewsToChat(api: Api, chatId: number, spheres: readonly string[]) {
  const cleaned = sanitizeSpheres(spheres);
  const sphereId = pickRandomSphere(cleaned);
  if (!sphereId) throw new Error('No news spheres selected');
  const label = sphereLabel(sphereId);
  const { text, usage } = await generateInterestingNews(sphereId, label);
  await recordOpenAiUsage(chatId, {
    kind: 'news',
    model: usage.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    imageCount: usage.imageCount,
    estimatedCostUsd: usage.estimatedCostUsd,
  }).catch(() => console.error('OpenAI usage record failed', { chatId, kind: 'news' }));
  // One news item → one Telegram message (avoid partial multi-part sends + duplicate retries).
  const body = (text.trim() || ' ').slice(0, config.TELEGRAM_MAX_MESSAGE_LENGTH);
  await api.sendMessage(chatId, body, { link_preview_options: { is_disabled: true } });
}

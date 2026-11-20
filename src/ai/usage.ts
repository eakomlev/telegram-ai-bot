import { config } from '../config.js';
import type { OpenAiUsageTotals } from '../core/db.js';

export type UsageKind = 'summary' | 'mention' | 'gif' | 'news' | 'auto_answer' | 'chat_memory';

export type AiUsage = {
  model: string;
  promptTokens: number;
  completionTokens: number;
  imageCount: number;
  estimatedCostUsd: number;
};

export function estimateTextCostUsd(promptTokens: number, completionTokens: number) {
  return (
    (promptTokens / 1_000_000) * config.OPENAI_INPUT_USD_PER_1M_TOKENS +
    (completionTokens / 1_000_000) * config.OPENAI_OUTPUT_USD_PER_1M_TOKENS
  );
}

export function estimateImageCostUsd(imageCount: number) {
  return Math.max(0, imageCount) * config.OPENAI_IMAGE_USD;
}

export function buildAiUsage(params: {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  imageCount?: number;
}): AiUsage {
  const promptTokens = Math.max(0, Math.round(params.promptTokens ?? 0));
  const completionTokens = Math.max(0, Math.round(params.completionTokens ?? 0));
  const imageCount = Math.max(0, Math.round(params.imageCount ?? 0));
  return {
    model: params.model,
    promptTokens,
    completionTokens,
    imageCount,
    estimatedCostUsd: estimateTextCostUsd(promptTokens, completionTokens) + estimateImageCostUsd(imageCount),
  };
}

export function formatUsd(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatUsageReport(month: OpenAiUsageTotals) {
  const tokens = month.promptTokens + month.completionTokens;
  return [
    'Статистика по группе за текущий месяц:',
    `Потрачено: ${formatTokens(tokens)} токенов`,
  ].join('\n');
}

/** Owner `/stats` report: month growth + per-chat members/tokens. */
export function formatOwnerStatsReport(input: {
  newChatsThisMonth: number;
  newMembersThisMonth: number;
  chats: Array<{ name: string; members?: number; tokens: number }>;
}): string {
  const lines = [
    '——',
    'Новых в этом месяце',
    `Чаты: ${input.newChatsThisMonth}`,
    `Участники: ${input.newMembersThisMonth}`,
    '——',
    'Статистика чатов:',
  ];
  for (const chat of input.chats) {
    const members = typeof chat.members === 'number' ? String(chat.members) : '—';
    lines.push(`${chat.name} - ${members} - ${chat.tokens}`);
  }
  lines.push('——');
  return lines.join('\n');
}

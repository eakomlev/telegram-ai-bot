import { config } from '../config.js';
import type { OpenAiUsageTotals } from '../core/db.js';

export type UsageKind = 'summary' | 'mention' | 'gif' | 'news' | 'auto_answer' | 'personalization';

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

function formatPeriod(label: string, totals: OpenAiUsageTotals, extraLines: string[] = []) {
  const tokens = totals.promptTokens + totals.completionTokens;
  return [
    `${label}: ${formatUsd(totals.estimatedCostUsd)}`,
    `  запросов: ${totals.requests} (саммари ${totals.summaryRequests}, @упоминания ${totals.mentionRequests}, gif ${totals.gifRequests}, новости ${totals.newsRequests}, автоответ ${totals.autoAnswerRequests}, персонализация ${totals.personalizationRequests})`,
    `  токены: ${formatTokens(tokens)} (in ${formatTokens(totals.promptTokens)} / out ${formatTokens(totals.completionTokens)})`,
    `  картинки: ${totals.imageCount}`,
    ...extraLines.map((line) => `  ${line}`),
  ].join('\n');
}

export function formatUsageReport(today: OpenAiUsageTotals, total: OpenAiUsageTotals) {
  return [
    'Расходы OpenAI по этой группе (оценка по токенам и ценам из env):',
    '',
    formatPeriod('Сегодня (UTC)', today),
    '',
    formatPeriod('За всё время хранения', total),
    '',
    `Цены: текст in $${config.OPENAI_INPUT_USD_PER_1M_TOKENS}/1M, out $${config.OPENAI_OUTPUT_USD_PER_1M_TOKENS}/1M; картинка $${config.OPENAI_IMAGE_USD}.`,
    'Это не счёт из кабинета OpenAI — ориентир для сравнения чатов.',
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

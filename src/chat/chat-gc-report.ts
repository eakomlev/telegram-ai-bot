import type { ChatGcReport } from './chat-gc-scheduler.js';

function idList(ids: number[]): string {
  return ids.join(', ');
}

/** Russian summary of one chat-existence pass. */
export function formatChatGcReport(report: ChatGcReport): string {
  if (report.candidates === 0) return 'Нет известных групп для проверки.';
  const lines = [
    'Проверка групп завершена.',
    `Проверено: ${report.checked} из ${report.candidates}`,
    `На месте: ${report.alive}`,
  ];
  if (report.purged.length === 0) {
    lines.push('Удалять было нечего.');
  } else {
    lines.push(`Удалены из базы (${report.purged.length}):`);
    for (const row of report.purged) {
      const note = row.kind === 'upgrade' ? ' — группа стала супергруппой' : '';
      lines.push(`${row.chatId}${note}`);
    }
  }
  if (report.probeErrors.length) {
    lines.push(`Временные ошибки, данные сохранены: ${idList(report.probeErrors)}`);
  }
  if (report.purgeErrors.length) {
    lines.push(`Не удалось удалить: ${idList(report.purgeErrors)}`);
  }
  if (report.rateLimited) {
    lines.push('Дальше не проверял: Telegram ограничил частоту запросов.');
  }
  return lines.join('\n');
}

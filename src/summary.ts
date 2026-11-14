export type Selection = { kind: 'count'; count: number } | { kind: 'hours'; hours: number };
export type ChatMessage = { message_id: number; author: string; text: string; sent_at: Date };

export function parseSelection(input: string, defaultCount: number, maxCount: number, retentionDays: number): Selection {
  const value = input.trim().toLowerCase();
  if (!value) return { kind: 'count', count: defaultCount };
  if (/^\d+$/.test(value)) {
    const count = Number(value);
    if (count >= 1 && count <= maxCount) return { kind: 'count', count };
  }
  const period = /^(\d+)(h|d)$/.exec(value);
  if (period) {
    const hours = Number(period[1]) * (period[2] === 'd' ? 24 : 1);
    if (hours >= 1 && hours <= retentionDays * 24) return { kind: 'hours', hours };
  }
  throw new Error(`Используйте N (1–${maxCount}) или 24h / 7d (до ${retentionDays} дней), например /summary 100 или /verse 24h.`);
}

// Input rows are chronological. Keep the latest messages within the text budget.
export function prepareMessages(rows: ChatMessage[], maxChars: number) {
  const selected: object[] = [];
  let used = 2; // JSON array brackets
  let truncated = false;
  for (const row of [...rows].reverse()) {
    const entry = { id: row.message_id, at: row.sent_at.toISOString(), author: row.author, text: row.text };
    let encoded = JSON.stringify(entry);
    if (used + encoded.length + 1 > maxChars) {
      if (selected.length > 0) break;
      // An oversized latest message must not prevent a summary altogether.
      let low = 0;
      let high = row.text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const length = JSON.stringify({ ...entry, text: row.text.slice(0, mid) + ' [обрезано]' }).length;
        if (used + length + 1 <= maxChars) low = mid;
        else high = mid - 1;
      }
      entry.text = row.text.slice(0, low) + ' [обрезано]';
      encoded = JSON.stringify(entry);
      if (used + encoded.length + 1 > maxChars) break;
      truncated = true;
    }
    selected.unshift(entry);
    used += encoded.length + 1;
  }
  return { json: JSON.stringify(selected), count: selected.length, limited: truncated || selected.length < rows.length };
}

export function splitReply(text: string, maxLength = 4000): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf('\n', maxLength);
    if (cut < maxLength / 2) cut = maxLength;
    // Do not split a UTF-16 surrogate pair (emoji).
    const code = remaining.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/** One preceding chat line used as OpenAI context (auto-answer / mention quote). */
export type ChatContextMessage = {
  author: string;
  text: string;
};

export function formatContextLine(message: ChatContextMessage) {
  const author = (message.author || 'Участник').replace(/\s+/g, ' ').trim() || 'Участник';
  const text = message.text.replace(/\s*\n\s*/g, ' ').trim();
  return `[${author}]: ${text}`;
}

/**
 * Keep newest messages within a char budget: drop oldest whole lines first;
 * if the newest alone still exceeds, truncate it with ….
 */
export function trimPrecedingContext(
  messages: ChatContextMessage[],
  maxChars: number,
): ChatContextMessage[] {
  if (maxChars <= 0 || messages.length === 0) return [];

  const selected = [...messages];
  const totalChars = () => {
    let used = 0;
    for (let i = 0; i < selected.length; i++) {
      used += formatContextLine(selected[i]!).length;
      if (i > 0) used += 1; // newline between lines
    }
    return used;
  };

  while (selected.length > 1 && totalChars() > maxChars) {
    selected.shift();
  }

  if (selected.length === 0) return [];
  if (totalChars() <= maxChars) return selected;

  // Single oversized newest line: shrink text until the formatted line fits.
  const newest = selected[0]!;
  const author = (newest.author || 'Участник').replace(/\s+/g, ' ').trim() || 'Участник';
  const prefix = `[${author}]: `;
  const ellipsis = '…';
  const budget = Math.max(0, maxChars - prefix.length - ellipsis.length);
  const compact = newest.text.replace(/\s*\n\s*/g, ' ').trim();
  return [{ author, text: `${compact.slice(0, budget)}${ellipsis}` }];
}

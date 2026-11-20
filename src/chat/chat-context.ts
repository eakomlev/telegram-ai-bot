/** One preceding chat line used as OpenAI context (auto-answer / mention quote). */
export type ChatContextMessage = {
  author: string;
  text: string;
};

/** Context line that may still know its Telegram message id (for dedupe). */
export type ContextLine = ChatContextMessage & { messageId?: number };

export function formatContextLine(message: ChatContextMessage) {
  const author = (message.author || 'Участник').replace(/\s+/g, ' ').trim() || 'Участник';
  const text = message.text.replace(/\s*\n\s*/g, ' ').trim();
  return `[${author}]: ${text}`;
}

/**
 * Keep newest messages within a char budget: drop oldest whole lines first;
 * if the newest alone still exceeds, truncate it with ….
 */
export function trimPrecedingContext<T extends ChatContextMessage>(
  messages: T[],
  maxChars: number,
): T[] {
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
  return [{ ...newest, author, text: `${compact.slice(0, budget)}${ellipsis}` }];
}

/**
 * The quoted message stays in the quote block, not the thread.
 * Trim each window first, then drop ids that survived in a higher-priority block
 * so a line cut from the thread can still appear in the recent window.
 */
export function prepareMentionContextBlocks(input: {
  recent: ContextLine[];
  aroundQuote: ContextLine[];
  thread: ContextLine[];
  quoteMessageId?: number;
  recentMaxChars: number;
  aroundQuoteMaxChars: number;
  threadMaxChars: number;
}): { recent: ContextLine[]; aroundQuote: ContextLine[]; thread: ContextLine[] } {
  const thread = input.quoteMessageId == null
    ? input.thread
    : input.thread.filter((line) => line.messageId !== input.quoteMessageId);
  return dedupeMentionContext({
    recent: trimPrecedingContext(input.recent, input.recentMaxChars),
    aroundQuote: trimPrecedingContext(input.aroundQuote, input.aroundQuoteMaxChars),
    thread: trimPrecedingContext(thread, input.threadMaxChars),
  });
}

/**
 * Walk reply_to_message_id from startId toward the root, including start.
 * Stops when the parent is missing, an id repeats, or maxMessages is reached.
 * maxMessages <= 0 or an unknown start yields []. Root is first.
 */
export function walkReplyChain<T extends { message_id: number; reply_to_message_id?: number | null }>(
  rowsById: ReadonlyMap<number, T>,
  startId: number,
  maxMessages: number,
): T[] {
  if (maxMessages <= 0) return [];
  const start = rowsById.get(startId);
  if (!start) return [];

  const chain: T[] = [];
  const seen = new Set<number>();
  let current: T | undefined = start;
  while (current && chain.length < maxMessages) {
    if (seen.has(current.message_id)) break;
    seen.add(current.message_id);
    chain.push(current);
    const parentId = current.reply_to_message_id;
    if (parentId == null) break;
    const parent = rowsById.get(parentId);
    if (!parent) break;
    if (seen.has(parent.message_id)) break;
    current = parent;
  }
  return chain.reverse();
}

/**
 * Same messageId is kept in thread, otherwise aroundQuote, otherwise recent.
 * Lines without messageId are not deduped and may appear in more than one block.
 * Order inside each block is preserved.
 */
export function dedupeMentionContext(blocks: {
  recent: ContextLine[];
  aroundQuote: ContextLine[];
  thread: ContextLine[];
}): { recent: ContextLine[]; aroundQuote: ContextLine[]; thread: ContextLine[] } {
  const idsIn = (lines: ContextLine[]) => new Set(
    lines.flatMap((line) => (line.messageId == null ? [] : [line.messageId])),
  );
  const threadIds = idsIn(blocks.thread);
  const aroundIds = idsIn(blocks.aroundQuote);
  const dropIf = (lines: ContextLine[], blocked: Set<number>) => lines.filter(
    (line) => line.messageId == null || !blocked.has(line.messageId),
  );
  const aroundBlocked = threadIds;
  const recentBlocked = new Set<number>([...threadIds, ...aroundIds]);
  return {
    recent: dropIf(blocks.recent, recentBlocked),
    aroundQuote: dropIf(blocks.aroundQuote, aroundBlocked),
    thread: blocks.thread,
  };
}

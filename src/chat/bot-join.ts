/**
 * Pure helpers for detecting when the bot joins a group/supergroup
 * and whether a welcome (help) message should be sent.
 */

export function isBotJoinTransition(oldStatus: string, newStatus: string): boolean {
  return (
    (oldStatus === 'left' || oldStatus === 'kicked') &&
    (newStatus === 'member' || newStatus === 'administrator')
  );
}

export function shouldSendBotJoinWelcome(input: {
  chatType: string;
  chatId: number;
  oldStatus: string;
  newStatus: string;
  allowedChatIds: ReadonlySet<string>; // empty set = allow all
}): boolean {
  if (input.chatType !== 'group' && input.chatType !== 'supergroup') return false;
  if (!isBotJoinTransition(input.oldStatus, input.newStatus)) return false;
  if (input.allowedChatIds.size > 0 && !input.allowedChatIds.has(String(input.chatId))) {
    return false;
  }
  return true;
}

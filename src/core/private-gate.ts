/**
 * Pure private-chat middleware gate: which updates call `next()`.
 * Callback queries always pass (handlers enforce their own auth).
 * Owner message commands: /stats, /costs, /personalize only.
 */
export function shouldPassPrivateMiddleware(input: {
  hasCallbackQuery: boolean;
  messageText: string;
  isOwner: boolean;
}): boolean {
  if (input.hasCallbackQuery) return true;
  return (
    input.isOwner &&
    /^\/(?:stats|costs|personalize)(?:@\w+)?(?:\s|$)/i.test(input.messageText)
  );
}

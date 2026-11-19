/**
 * Pure private-chat middleware gate: which updates call `next()`.
 * Callback queries always pass (handlers enforce their own auth).
 * Owner message commands: /stats, /costs, /personalize, /personalize_results
 * (optional hyphen alias /personalize-results for private gate only).
 */
export function shouldPassPrivateMiddleware(input: {
  hasCallbackQuery: boolean;
  messageText: string;
  isOwner: boolean;
}): boolean {
  if (input.hasCallbackQuery) return true;
  return (
    input.isOwner &&
    /^\/(?:stats|costs|personalize_results|personalize-results|personalize)(?:@\w+)?(?:\s|$)/i.test(
      input.messageText,
    )
  );
}

const PRIVATE_REDIRECT_DEFAULT =
  'Добавьте меня в чат или группу, чтобы начать работу.\nВ @BotFather: /setprivacy → Disable.';

const PRIVATE_REDIRECT_OWNER_COMMAND =
  'В личке доступны только /stats, /costs, /personalize и /personalize_results.';

/** Whether a blocked private update should get a reply (any `ctx.message`). */
export function shouldReplyToBlockedPrivate(input: { hasMessage: boolean }): boolean {
  return input.hasMessage;
}

/**
 * Reply text for a blocked private message.
 * Owner blocked slash commands keep the allowlist hint; everything else gets the group redirect.
 */
export function privateBlockedReplyText(input: {
  isOwner: boolean;
  messageText: string;
}): string {
  if (input.isOwner && input.messageText.startsWith('/')) {
    return PRIVATE_REDIRECT_OWNER_COMMAND;
  }
  return PRIVATE_REDIRECT_DEFAULT;
}

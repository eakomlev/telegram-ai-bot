import { GrammyError } from 'grammy';

/** Permanent delivery failures: stop scheduling / purge instead of burning retries. */
export function isPermanentTelegramDeliveryError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code === 403) return true;
  const description = error.description.toLowerCase();
  return (
    description.includes('chat not found')
    || description.includes('bot was kicked')
    || description.includes('bot is not a member')
    || description.includes('group chat was upgraded')
  );
}

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
    || description.includes('group is deactivated')
    || description.includes('peer_id_invalid')
  );
}

/**
 * Group → supergroup upgrade: old chat_id is dead but the community lives under a new id.
 * Still a permanent delivery failure for the old id; GC purges the orphaned old id.
 */
export function isChatUpgradeError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  const migrateTo = error.parameters?.migrate_to_chat_id;
  if (typeof migrateTo === 'number' && Number.isFinite(migrateTo)) return true;
  return error.description.toLowerCase().includes('group chat was upgraded');
}

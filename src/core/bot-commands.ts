/** Bot command entry for Telegram setMyCommands. */
export type BotCommandDef = {
  command: string;
  description: string;
};

/** Scopes used when registering the bot command menu. */
export type CommandScope =
  | { type: 'default' }
  | { type: 'all_group_chats' }
  | { type: 'all_private_chats' }
  | { type: 'chat'; chat_id: number };

export type CommandRegistrationStep =
  | { action: 'set'; commands: BotCommandDef[]; scope: CommandScope }
  | { action: 'delete'; scope: { type: 'all_private_chats' } };

export const GROUP_COMMANDS: BotCommandDef[] = [
  { command: 'summary', description: 'Саммари: N, 24h или 7d' },
  { command: 'verse', description: 'Саммари в стихах: N, 24h или 7d' },
  { command: 'gif', description: 'Шуточная GIF по последним сообщениям' },
  { command: 'settings', description: 'Настройки группы (админы)' },
  { command: 'memory', description: 'Память чата и закреплённые факты' },
  { command: 'remember', description: 'Добавить закреплённый факт' },
  { command: 'forget', description: 'Удалить закреплённые факты' },
  { command: 'usage', description: 'Токены OpenAI по группе (админы)' },
  { command: 'help', description: 'Как пользоваться ботом' },
  { command: 'privacy', description: 'Обработка данных' },
  { command: 'chatid', description: 'ID этой группы' },
];

export const OWNER_PRIVATE_COMMANDS: BotCommandDef[] = [
  { command: 'stats', description: 'Статистика чатов и рост за месяц (МСК)' },
  { command: 'costs', description: 'Официальный биллинг OpenAI (месяц МСК)' },
  { command: 'memory_refresh', description: 'Обновить память группы за 3 дня' },
  { command: 'check_chats', description: 'Проверить, что группы ещё доступны' },
];

/**
 * Pure plan for Telegram command-menu registration.
 * Owner private commands use BotCommandScopeChat (`chat`) for the owner's DM.
 * Private-chat resolution is: chat → all_private_chats → default.
 * (chat_member is only consulted for groups/supergroups, not private chats.)
 */
export function buildCommandRegistrationPlan(
  ownerUserId: number | undefined,
): CommandRegistrationStep[] {
  const steps: CommandRegistrationStep[] = [
    { action: 'set', commands: GROUP_COMMANDS, scope: { type: 'default' } },
    { action: 'set', commands: GROUP_COMMANDS, scope: { type: 'all_group_chats' } },
    // Drop any prior all_private_chats list from older deploys
    { action: 'delete', scope: { type: 'all_private_chats' } },
    // Explicit empty override so default groupCommands do NOT appear in DMs
    { action: 'set', commands: [], scope: { type: 'all_private_chats' } },
  ];

  if (ownerUserId !== undefined) {
    steps.push({
      action: 'set',
      commands: OWNER_PRIVATE_COMMANDS,
      scope: {
        type: 'chat',
        chat_id: ownerUserId,
      },
    });
  }

  return steps;
}

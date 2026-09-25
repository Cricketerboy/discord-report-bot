export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

export const MessageFlags = { EPHEMERAL: 1 << 6 } as const;

export const Permissions = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_GUILD: 1n << 5n,
  MANAGE_MESSAGES: 1n << 13n,
} as const;

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  version?: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser; permissions?: string; nick?: string | null };
  user?: DiscordUser;
  message?: { id: string; channel_id?: string };
  data?: {
    id?: string;
    name?: string;
    type?: number;
    options?: Array<{ name: string; type: number; value?: string | number | boolean }>;
    custom_id?: string;
    component_type?: number;
    components?: unknown[];
  };
}

export interface MessageBody {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  flags?: number;
  allowed_mentions?: { parse?: string[]; roles?: string[]; users?: string[] };
}

export function interactionUser(i: Interaction): DiscordUser | undefined {
  return i.member?.user ?? i.user;
}

export function displayName(i: Interaction): string {
  const u = interactionUser(i);
  return i.member?.nick || u?.global_name || u?.username || 'unknown';
}

export function hasPermission(i: Interaction, perm: bigint): boolean {
  const raw = i.member?.permissions;
  if (!raw) return false;
  try {
    const bits = BigInt(raw);
    return (bits & Permissions.ADMINISTRATOR) !== 0n || (bits & perm) !== 0n;
  } catch {
    return false;
  }
}

/** Walks a modal submission (classic action rows or newer label components) to find an input value. */
export function findModalValue(components: unknown, customId: string): string | undefined {
  if (!components || typeof components !== 'object') return undefined;
  if (Array.isArray(components)) {
    for (const c of components) {
      const found = findModalValue(c, customId);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const node = components as { custom_id?: string; value?: unknown; components?: unknown; component?: unknown };
  if (node.custom_id === customId && typeof node.value === 'string') return node.value;
  return findModalValue(node.components, customId) ?? findModalValue(node.component, customId);
}

/** Discord snowflakes embed their creation time; interaction tokens expire 15 minutes after it. */
export function snowflakeTime(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
}

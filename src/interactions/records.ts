import type { Queryable } from '../db/pool.js';
import { displayName, interactionUser, type Interaction } from '../discord/types.js';

export interface IngestRecord {
  id: string;
  token: string;
  type: number;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  userName: string | null;
  command: string | null;
  input: string | null;
  outcome: string;
}

export function toRecord(i: Interaction, command: string, input: string | null, outcome = 'received'): IngestRecord {
  return {
    id: i.id,
    token: i.token,
    type: i.type,
    guildId: i.guild_id ?? null,
    channelId: i.channel_id ?? null,
    userId: interactionUser(i)?.id ?? null,
    userName: displayName(i),
    command,
    input: input ? input.slice(0, 2000) : null,
    outcome,
  };
}

/** Returns true if this call inserted the row, false if the interaction id was already recorded. */
export async function insertRecord(db: Queryable, rec: IngestRecord, spooled = false): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO interactions (id, token, type, guild_id, channel_id, user_id, user_name, command, input, outcome, spooled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
    [rec.id, rec.token, rec.type, rec.guildId, rec.channelId, rec.userId, rec.userName, rec.command, rec.input, rec.outcome, spooled],
  );
  return (res.rowCount ?? 0) > 0;
}

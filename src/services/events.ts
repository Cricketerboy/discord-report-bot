import { EventEmitter } from 'node:events';
import { pool, type Queryable } from '../db/pool.js';
import { logger } from '../logger.js';
import { redact, redactDeep } from '../lib/redact.js';

/** In-process bus that feeds the dashboard's live (SSE) stream. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function notifyChange(guildId: string | null | undefined): void {
  bus.emit('change', { guildId: guildId ?? null });
}

export type Level = 'info' | 'warn' | 'error';

export interface EventInput {
  guildId?: string | null;
  interactionId?: string | null;
  level?: Level;
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Writes a structured log line AND a row in `events` (the dashboard's audit trail).
 * Recording an event must never break the operation it describes, so DB failures are only logged.
 */
export async function recordEvent(ev: EventInput, db: Queryable = pool): Promise<void> {
  const level = ev.level ?? 'info';
  const message = redact(ev.message).slice(0, 1000);
  const data = redactDeep(ev.data ?? {});
  logger[level]({ kind: ev.kind, guildId: ev.guildId, interactionId: ev.interactionId, ...data }, message);
  try {
    await db.query('INSERT INTO events (guild_id, interaction_id, level, kind, message, data) VALUES ($1,$2,$3,$4,$5,$6)', [
      ev.guildId ?? null,
      ev.interactionId ?? null,
      level,
      ev.kind,
      message,
      JSON.stringify(data),
    ]);
    notifyChange(ev.guildId);
  } catch (err) {
    logger.warn({ kind: ev.kind, err: err instanceof Error ? redact(err.message) : 'unknown' }, 'failed to persist event');
  }
}

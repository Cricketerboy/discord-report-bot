import { EventEmitter } from 'node:events';
import { pool, query, type Queryable } from '../db/pool.js';
import { notifyChange } from '../services/events.js';

export type JobKind = 'report.process' | 'discord.reply' | 'discord.post_report' | 'mirror.send' | 'status.reply' | 'component.apply';

export const MAX_ATTEMPTS: Record<JobKind, number> = {
  'report.process': 6,
  'discord.reply': 8, // interaction tokens die after 15 minutes; 8 attempts spans ~8 minutes
  'discord.post_report': 10,
  'mirror.send': 10,
  'status.reply': 6,
  'component.apply': 8,
};

export interface JobSpec {
  kind: JobKind;
  dedupeKey: string;
  guildId?: string | null;
  interactionId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
}

export interface JobRow {
  id: string;
  kind: JobKind;
  dedupe_key: string;
  guild_id: string | null;
  interaction_id: string | null;
  payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'succeeded' | 'dead';
  attempts: number;
  max_attempts: number;
  run_at: Date;
  last_error: string | null;
}

const wake = new EventEmitter();
export const onWake = (fn: () => void) => wake.on('wake', fn);
export function wakeWorker(): void {
  wake.emit('wake');
}

/** Idempotent: a second enqueue with the same dedupe key is a no-op. Safe to call inside a transaction. */
export async function enqueue(db: Queryable, spec: JobSpec): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO jobs (kind, dedupe_key, guild_id, interaction_id, payload, max_attempts, run_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING`,
    [spec.kind, spec.dedupeKey, spec.guildId ?? null, spec.interactionId ?? null, JSON.stringify(spec.payload ?? {}), MAX_ATTEMPTS[spec.kind], spec.runAt ?? new Date()],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Claims one due job. SKIP LOCKED lets overlapping instances (e.g. during a deploy) share the queue safely. */
export async function claimNext(workerId: string): Promise<JobRow | null> {
  const { rows } = await query<JobRow>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = $1, updated_at = now()
      WHERE id = (
        SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now()
         ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
    [workerId],
  );
  return rows[0] ?? null;
}

export async function markSucceeded(job: JobRow): Promise<void> {
  await query(`UPDATE jobs SET status = 'succeeded', completed_at = now(), updated_at = now(), last_error = NULL, locked_by = NULL WHERE id = $1`, [job.id]);
  notifyChange(job.guild_id);
}

export function backoffMs(attempt: number, retryAfterMs?: number): number {
  const base = Math.min(300_000, 2000 * 2 ** Math.max(0, attempt - 1));
  const jittered = base * (0.8 + Math.random() * 0.4);
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** Returns the resulting state so the caller can log it. */
export async function markFailed(job: JobRow, error: string, retryable: boolean, retryAfterMs?: number): Promise<'retrying' | 'dead'> {
  const dead = !retryable || job.attempts >= job.max_attempts;
  if (dead) {
    await query(`UPDATE jobs SET status = 'dead', last_error = $2, completed_at = now(), updated_at = now(), locked_by = NULL WHERE id = $1`, [job.id, error]);
  } else {
    const delay = backoffMs(job.attempts, retryAfterMs);
    await query(
      `UPDATE jobs SET status = 'pending', last_error = $2, run_at = now() + ($3 || ' milliseconds')::interval, updated_at = now(), locked_by = NULL WHERE id = $1`,
      [job.id, error, String(Math.round(delay))],
    );
  }
  notifyChange(job.guild_id);
  return dead ? 'dead' : 'retrying';
}

/** Milliseconds until the earliest pending job is due, or null if the queue is empty. */
export async function msUntilNextJob(): Promise<number | null> {
  const { rows } = await query<{ ms: number | null }>(
    `SELECT GREATEST(0, EXTRACT(EPOCH FROM (min(run_at) - now())) * 1000)::float8 AS ms FROM jobs WHERE status = 'pending'`,
  );
  const ms = rows[0]?.ms;
  return ms === null || ms === undefined ? null : Number(ms);
}

/** Jobs left 'running' by a crashed/restarted process are returned to the queue. */
export async function recoverStaleJobs(olderThanSeconds = 120): Promise<number> {
  const res = await query(
    `UPDATE jobs SET status = 'pending', locked_by = NULL, updated_at = now(), last_error = COALESCE(last_error, 'recovered after worker restart')
      WHERE status = 'running' AND locked_at < now() - ($1 || ' seconds')::interval`,
    [String(olderThanSeconds)],
  );
  return res.rowCount ?? 0;
}

/** Dashboard "retry now": gives a dead or backing-off job a fresh attempt budget. */
export async function retryJob(jobId: string, guildId: string): Promise<boolean> {
  const res = await query(
    `UPDATE jobs SET status = 'pending', run_at = now(), max_attempts = attempts + 3, updated_at = now(), completed_at = NULL
      WHERE id = $1 AND guild_id = $2 AND status IN ('dead', 'pending')`,
    [jobId, guildId],
  );
  if (res.rowCount) wakeWorker();
  return (res.rowCount ?? 0) > 0;
}

/**
 * Rolls job states up into the interaction's outcome shown on the dashboard:
 * processing while anything is queued, failed/partial if something went dead, completed otherwise.
 */
export async function refreshInteractionOutcome(interactionId: string, db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE interactions i SET
        outcome = CASE
          WHEN s.pending > 0 THEN 'processing'
          WHEN s.dead > 0 AND s.ok > 0 THEN 'partial'
          WHEN s.dead > 0 THEN 'failed'
          ELSE 'completed' END,
        completed_at = CASE WHEN s.pending > 0 THEN NULL ELSE COALESCE(i.completed_at, now()) END
       FROM (SELECT count(*) FILTER (WHERE status IN ('pending','running')) AS pending,
                    count(*) FILTER (WHERE status = 'dead') AS dead,
                    count(*) FILTER (WHERE status = 'succeeded') AS ok
               FROM jobs WHERE interaction_id = $1) s
      WHERE i.id = $1 AND i.outcome NOT IN ('rejected', 'duplicate')`,
    [interactionId],
  );
}

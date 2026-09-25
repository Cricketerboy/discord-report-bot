import type pg from 'pg';
import { pool, query, tx } from '../db/pool.js';
import { withTimeout } from '../lib/http.js';
import { errorMessage } from '../lib/redact.js';
import { logger } from '../logger.js';
import { enqueue, wakeWorker, type JobSpec } from '../jobs/queue.js';
import { insertRecord, type IngestRecord } from './records.js';
import { spool } from './spool.js';
// ---- first line of dedup: in-memory, works even when the database is unreachable ----

const SEEN_TTL_MS = 30 * 60_000;
const seen = new Map<string, number>();

export function alreadySeen(id: string): boolean {
  const at = seen.get(id);
  return at !== undefined && Date.now() - at < SEEN_TTL_MS;
}

export function markSeen(id: string): void {
  seen.set(id, Date.now());
  if (seen.size > 10_000) {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [k, v] of seen) if (v < cutoff || seen.size > 8_000) seen.delete(k);
  }
}

export type IngestResult<T> = { status: 'new'; value: T } | { status: 'duplicate' } | { status: 'spooled' };

/**
 * Durably records an interaction and the jobs it owes, atomically, before we acknowledge Discord.
 * The interaction id primary key is the authoritative dedup check.
 *
 * If the database doesn't answer within the budget, the record + `spoolJobs` go to the local spool and
 * are replayed into the DB when it's back. Everything written here is idempotent (ON CONFLICT DO NOTHING
 * on interaction id and job dedupe keys), so a transaction that "timed out" but later committed is harmless.
 */
export async function ingest<T = undefined>(
  rec: IngestRecord,
  jobs: JobSpec[],
  opts: { budgetMs: number; extra?: (c: pg.PoolClient) => Promise<T>; spoolJobs?: JobSpec[] },
): Promise<IngestResult<T>> {
  const toSpool = () => {
    spool.add({ record: rec, jobs: opts.spoolJobs ?? jobs });
    return { status: 'spooled' } as const;
  };
  if (opts.budgetMs < 100) return toSpool();

  try {
    const result = await withTimeout(
      tx(async (c): Promise<IngestResult<T>> => {
        if (!(await insertRecord(c, rec))) return { status: 'duplicate' };
        const value = opts.extra ? await opts.extra(c) : (undefined as T);
        for (const job of jobs) await enqueue(c, job);
        return { status: 'new', value };
      }),
      opts.budgetMs,
      'ingest',
    );
    if (result.status === 'new' && jobs.length) wakeWorker();
    return result;
  } catch (err) {
    logger.warn({ interactionId: rec.id, err: errorMessage(err) }, 'database slow/unavailable during ingest; spooling interaction');
    return toSpool();
  }
}

/** For interactions answered without follow-up work (modal opened, command rejected): record, never block. */
export function recordBestEffort(rec: IngestRecord): void {
  void withTimeout(insertRecord(pool, rec), 5000, 'record interaction').catch((err) =>
    logger.warn({ interactionId: rec.id, err: errorMessage(err) }, 'could not record interaction'),
  );
}

export async function enqueueOrSpool(rec: IngestRecord, job: JobSpec, budgetMs: number): Promise<void> {
  try {
    if (budgetMs < 100) throw new Error('no time left');
    await withTimeout(enqueue(pool, job), budgetMs, 'enqueue');
    wakeWorker();
  } catch {
    spool.add({ record: rec, jobs: [job] });
  }
}

export async function recordResponseMeta(id: string, responseType: number, ms: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await query('UPDATE interactions SET response_type = $2, response_ms = $3 WHERE id = $1', [id, responseType, ms]);
      if (res.rowCount) return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export async function markInteractionCompleted(id: string): Promise<void> {
  await query(`UPDATE interactions SET outcome = 'completed', completed_at = now() WHERE id = $1`, [id]).catch(() => undefined);
}

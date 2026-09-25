import { randomUUID } from 'node:crypto';
import { JobError } from '../lib/http.js';
import { errorMessage } from '../lib/redact.js';
import { logger } from '../logger.js';
import { recordEvent } from '../services/events.js';
import { handlers } from './handlers.js';
import { claimNext, markFailed, markSucceeded, msUntilNextJob, onWake, recoverStaleJobs, refreshInteractionOutcome, type JobRow } from './queue.js';

const CONCURRENCY = 4;
// When idle the worker sleeps until the next scheduled retry, or this long at most. Waking is otherwise
// event-driven (enqueue in this process), so an idle bot lets serverless Postgres (Neon) scale to zero
// instead of burning the free tier's compute hours.
const IDLE_POLL_MS = 30 * 60_000;
const DB_ERROR_BACKOFF_MS = 5000;

export class Worker {
  readonly id = `worker-${randomUUID().slice(0, 8)}`;
  private running = 0;
  private claiming = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private active = new Set<Promise<void>>();

  start(): void {
    onWake(() => this.tick());
    // Jobs left 'running' by a previous process are handed back. The 30s grace avoids stealing work
    // from the old instance during a zero-downtime deploy (handlers are idempotent regardless).
    void recoverStaleJobs(30)
      .catch((err) => logger.warn({ err: errorMessage(err) }, 'stale job recovery failed'))
      .finally(() => this.tick());
    logger.info({ workerId: this.id }, 'job worker started');
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void recoverStaleJobs().catch(() => undefined);
      this.tick();
    }, Math.max(50, Math.min(ms, IDLE_POLL_MS)));
  }

  tick(): void {
    if (this.stopped || this.claiming || this.running >= CONCURRENCY) return;
    this.claiming = true;
    claimNext(this.id).then(
      async (job) => {
        this.claiming = false;
        if (!job) {
          const next = await msUntilNextJob().catch(() => null);
          this.schedule(next ?? IDLE_POLL_MS);
          return;
        }
        this.running++;
        const p: Promise<void> = this.execute(job).finally(() => {
          this.running--;
          this.active.delete(p);
          this.tick();
        });
        this.active.add(p);
        this.tick(); // claim more in parallel while there is work
      },
      (err) => {
        // DB unreachable: back off; jobs are safe in the table (or the spool) until it returns.
        this.claiming = false;
        logger.warn({ err: errorMessage(err) }, 'worker could not reach database; backing off');
        this.schedule(DB_ERROR_BACKOFF_MS);
      },
    );
  }

  private async execute(job: JobRow): Promise<void> {
    const started = Date.now();
    const ctx = { guildId: job.guild_id, interactionId: job.interaction_id };
    try {
      await handlers[job.kind](job);
      await markSucceeded(job);
      logger.info({ jobId: job.id, kind: job.kind, attempt: job.attempts, ms: Date.now() - started, ...ctx }, 'job succeeded');
      if (job.attempts > 1) {
        await recordEvent({ ...ctx, kind: 'job.recovered', message: `${job.kind} succeeded on attempt ${job.attempts}`, data: { jobId: job.id } });
      }
    } catch (err) {
      const retryable = err instanceof JobError ? err.retryable : true;
      const retryAfterMs = err instanceof JobError ? err.retryAfterMs : undefined;
      const message = errorMessage(err);
      let state: 'retrying' | 'dead' = 'retrying';
      try {
        state = await markFailed(job, message, retryable, retryAfterMs);
      } catch (markErr) {
        // Couldn't record the failure; the stale-lock sweep will hand the job back to the queue.
        logger.error({ jobId: job.id, err: errorMessage(markErr) }, 'failed to record job failure');
      }
      await recordEvent({
        ...ctx,
        level: state === 'dead' ? 'error' : 'warn',
        kind: state === 'dead' ? 'job.dead' : 'job.retry',
        message:
          state === 'dead'
            ? `${job.kind} failed permanently after ${job.attempts} attempt(s): ${message}`
            : `${job.kind} attempt ${job.attempts}/${job.max_attempts} failed, will retry: ${message}`,
        data: { jobId: job.id, attempt: job.attempts, retryable },
      });
    } finally {
      if (job.interaction_id) await refreshInteractionOutcome(job.interaction_id).catch(() => undefined);
    }
  }

  async stop(timeoutMs = 8000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.race([Promise.allSettled([...this.active]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}

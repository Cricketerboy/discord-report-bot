import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { tx } from '../db/pool.js';
import { errorMessage } from '../lib/redact.js';
import { logger } from '../logger.js';
import { enqueue, wakeWorker, type JobSpec } from '../jobs/queue.js';
import { recordEvent } from '../services/events.js';
import { insertRecord, type IngestRecord } from './records.js';

interface SpoolItem {
  record: IngestRecord;
  jobs: JobSpec[];
  at: number;
}

const MAX_AGE_MS = 24 * 60 * 60_000;
const DRAIN_EVERY_MS = 3000;

/**
 * Write-ahead buffer for interactions that arrived while Postgres was unreachable.
 * Kept in memory and mirrored to disk so a process restart during a DB outage doesn't drop them.
 * (On a free host the disk is ephemeral, so this covers DB blips and restarts, not host loss.)
 */
class Spool {
  private items = new Map<string, SpoolItem>();
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private readonly file = join(config.SPOOL_DIR, 'spool.json');
  dropped = 0;

  get size(): number {
    return this.items.size;
  }

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as SpoolItem[];
      for (const item of raw) this.items.set(item.record.id, item);
      if (this.items.size) logger.warn({ count: this.items.size }, 'loaded spooled interactions from disk');
    } catch {
      /* no spool file yet */
    }
  }

  private persist(): void {
    try {
      mkdirSync(config.SPOOL_DIR, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.items.values()]));
      renameSync(tmp, this.file);
    } catch (err) {
      logger.error({ err: errorMessage(err) }, 'could not persist spool to disk');
    }
  }

  add(item: Omit<SpoolItem, 'at'>): void {
    const existing = this.items.get(item.record.id);
    const jobs = [...(existing?.jobs ?? []), ...item.jobs.filter((j) => !existing?.jobs.some((e) => e.dedupeKey === j.dedupeKey))];
    this.items.set(item.record.id, { record: item.record, jobs, at: existing?.at ?? Date.now() });
    this.persist();
    logger.warn({ interactionId: item.record.id, spoolSize: this.items.size }, 'interaction spooled');
  }

  async drainOnce(): Promise<void> {
    if (this.draining || !this.items.size) return;
    this.draining = true;
    try {
      for (const [id, item] of [...this.items]) {
        if (Date.now() - item.at > MAX_AGE_MS) {
          this.items.delete(id);
          this.dropped++;
          logger.error({ interactionId: id }, 'spooled interaction expired before the database came back');
          continue;
        }
        try {
          await tx(async (c) => {
            await insertRecord(c, item.record, true);
            for (const job of item.jobs) await enqueue(c, job);
          });
        } catch (err) {
          logger.warn({ err: errorMessage(err), spoolSize: this.items.size }, 'database still unavailable; spool retained');
          break;
        }
        this.items.delete(id);
        await recordEvent({
          guildId: item.record.guildId,
          interactionId: id,
          level: 'warn',
          kind: 'interaction.recovered',
          message: `Interaction recovered from spool after ${Math.round((Date.now() - item.at) / 1000)}s database outage`,
        });
      }
      wakeWorker();
    } finally {
      this.persist();
      this.draining = false;
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.drainOnce(), DRAIN_EVERY_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.drainOnce().catch(() => undefined);
    this.persist();
  }
}

export const spool = new Spool();

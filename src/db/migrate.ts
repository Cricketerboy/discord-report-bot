import { tx } from './pool.js';
import { schemaSql } from './schema.js';

const MIGRATION_LOCK_ID = 7_345_901;

/**
 * Transaction-scoped advisory lock (not session-scoped): it is released by COMMIT/ROLLBACK, so it also
 * behaves correctly behind a transaction-mode pooler such as Neon's "-pooler" endpoint or PgBouncer.
 */
export async function migrate(): Promise<void> {
  await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await c.query(schemaSql);
  });
}

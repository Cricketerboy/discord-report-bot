import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Builds pg options from DATABASE_URL. `sslmode` is interpreted here rather than by pg so behaviour
 * is explicit: disable -> no TLS, no-verify -> TLS without cert verification (some poolers need it),
 * anything else -> TLS with full verification. `channel_binding` (added by Neon's copy button) is dropped.
 */
export function poolOptions(databaseUrl: string, max: number): pg.PoolConfig {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');

  let ssl: pg.PoolConfig['ssl'] = false;
  if (sslmode && sslmode !== 'disable') ssl = { rejectUnauthorized: sslmode !== 'no-verify' };

  return {
    connectionString: url.toString(),
    ssl,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Guard against a hung query pinning a connection forever.
    query_timeout: 15_000,
  };
}

export const pool = new pg.Pool(poolOptions(config.DATABASE_URL, config.DATABASE_POOL_MAX));

// Serverless Postgres (Neon) closes idle connections; without this handler that would crash the process.
pool.on('error', (err) => logger.warn({ err: err.message }, 'idle database client error'));

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
  return pool.query<R>(text, params);
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

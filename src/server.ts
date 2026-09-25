import { config } from './config.js';
import { logger } from './logger.js';
import { createApp } from './app.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { spool } from './interactions/spool.js';
import { Worker } from './jobs/worker.js';
import { errorMessage } from './lib/redact.js';
import { warmGuildCache } from './services/guilds.js';
import { seedAdmin } from './web/auth.js';

process.on('unhandledRejection', (reason) => logger.error({ err: errorMessage(reason) }, 'unhandled promise rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err: errorMessage(err) }, 'uncaught exception; exiting so the platform restarts us');
  process.exit(1);
});

async function bootDatabase(): Promise<void> {
  // Serverless Postgres may be cold; retry for ~2 minutes before giving up (the platform will restart us).
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      await seedAdmin();
      await warmGuildCache();
      logger.info('database ready');
      return;
    } catch (err) {
      if (attempt >= 8) throw err;
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      logger.warn({ attempt, delayMs: delay, err: errorMessage(err) }, 'database not ready; retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function main(): Promise<void> {
  const app = createApp();
  // Start listening first: signature checks and PING work (and interactions get spooled) even if the DB is slow to boot.
  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, baseUrl: config.baseUrl }, 'http server listening'));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  spool.load();
  spool.start();

  await bootDatabase();
  const worker = new Worker();
  worker.start();

  // Free Render instances sleep after 15 idle minutes, and Discord does not retry an interaction that
  // times out against a sleeping host. A self-ping through the public URL keeps the instance warm.
  let keepalive: NodeJS.Timeout | null = null;
  if (config.KEEPALIVE && config.baseUrl.startsWith('https://')) {
    keepalive = setInterval(() => {
      fetch(`${config.baseUrl}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    }, 10 * 60_000);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    if (keepalive) clearInterval(keepalive);
    server.close();
    await worker.stop();
    await spool.stop();
    await pool.end().catch(() => undefined);
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: errorMessage(err) }, 'failed to start');
  process.exit(1);
});

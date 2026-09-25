import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { config, isProd } from './config.js';
import { pool } from './db/pool.js';
import { interactionsRouter } from './interactions/route.js';
import { withTimeout } from './lib/http.js';
import { errorMessage } from './lib/redact.js';
import { logger } from './logger.js';
import { apiRouter } from './web/api.js';
import { authRouter, loadSession } from './web/auth.js';
import { connectRouter } from './web/connect.js';
import { dashboardRouter } from './web/dashboard.js';
import { errorPage } from './web/views.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Render's proxy; needed for req.ip and secure cookies

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'data:', 'https://cdn.discordapp.com'],
          'script-src': ["'self'"],
          'connect-src': ["'self'"],
          // Only upgrade on the real https deployment; locally it would break loading over http://localhost.
          'upgrade-insecure-requests': isProd ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Liveness (no DB) for the platform + keep-alive pings; readiness checks the database.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });
  app.get('/health/ready', async (_req, res) => {
    try {
      await withTimeout(pool.query('SELECT 1'), 5000, 'db ping');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'database unavailable' });
    }
  });

  // Must be mounted before any body parser: it needs the raw bytes for signature verification.
  app.use(interactionsRouter());

  app.use('/static', express.static(publicDir, { maxAge: '1h', index: false }));
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(express.json({ limit: '32kb' }));

  // Defence in depth on top of CSRF tokens: reject cross-origin form posts outright.
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin');
    if (!origin) return next();
    const expected = new Set([new URL(config.baseUrl).origin, `${req.protocol}://${req.get('host')}`]);
    if (!expected.has(origin)) {
      res.status(403).send('Cross-origin request blocked.');
      return;
    }
    next();
  });

  app.use(loadSession);
  app.get('/', (req, res) => res.redirect(req.session ? '/dashboard' : '/login'));
  app.use(authRouter());
  app.use(connectRouter());
  app.use(dashboardRouter());
  app.use(apiRouter());

  app.use((req, res) => {
    res.status(404).send(errorPage(404, 'Page not found.', req.session));
  });

  // Express 5 forwards async errors here. Never leak internals to the client.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode ?? 500;
    if (status >= 500) logger.error({ err: errorMessage(err), path: req.path }, 'unhandled request error');
    if (res.headersSent) return;
    if (req.path.startsWith('/api/') || req.path === '/interactions') {
      res.status(status).json({ error: status >= 500 ? 'internal error' : 'bad request' });
      return;
    }
    res.status(status).send(errorPage(status, status >= 500 ? 'Something went wrong. It has been logged.' : 'Bad request.', req.session));
  });

  return app;
}

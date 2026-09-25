import { Router, type NextFunction, type Request, type Response } from 'express';
import { config, isProd } from '../config.js';
import { query } from '../db/pool.js';
import { hashPassword, randomToken, safeEqual, sha256, verifyPassword } from '../lib/crypto.js';
import { logger } from '../logger.js';
import { authPage } from './views.js';

export interface SessionInfo {
  idHash: string;
  adminId: number;
  email: string;
  csrf: string;
  oauthState: string | null;
  oauthStateAt: Date | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionInfo;
  }
}

// __Host- prefix: cookie is Secure, host-only and path=/ — cannot be set or shadowed by subdomains.
const COOKIE = isProd ? '__Host-sid' : 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const sid = req.cookies?.[COOKIE] as string | undefined;
  if (sid && sid.length < 200) {
    try {
      const { rows } = await query<{ id_hash: string; admin_id: number; email: string; csrf_token: string; oauth_state: string | null; oauth_state_at: Date | null }>(
        `SELECT s.id_hash, s.admin_id, a.email, s.csrf_token, s.oauth_state, s.oauth_state_at
           FROM sessions s JOIN admins a ON a.id = s.admin_id
          WHERE s.id_hash = $1 AND s.expires_at > now()`,
        [sha256(sid)],
      );
      const r = rows[0];
      if (r) {
        req.session = { idHash: r.id_hash, adminId: r.admin_id, email: r.email, csrf: r.csrf_token, oauthState: r.oauth_state, oauthStateAt: r.oauth_state_at };
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'session lookup failed');
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session) return next();
  if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

/** Synchronizer-token CSRF check for every state-changing dashboard request. */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const token = (req.body?._csrf as string | undefined) ?? req.get('x-csrf-token');
  if (!req.session || !token || !safeEqual(token, req.session.csrf)) {
    res.status(403).send('Invalid or missing CSRF token. Reload the page and try again.');
    return;
  }
  next();
}

async function createSession(res: Response, adminId: number): Promise<void> {
  const sid = randomToken();
  await query('INSERT INTO sessions (id_hash, admin_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)', [
    sha256(sid),
    adminId,
    randomToken(24),
    new Date(Date.now() + SESSION_TTL_MS),
  ]);
  res.cookie(COOKIE, sid, { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS });
}

export async function setOAuthState(session: SessionInfo, state: string | null): Promise<void> {
  await query('UPDATE sessions SET oauth_state = $2, oauth_state_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id_hash = $1', [session.idHash, state]);
}

/** Creates or updates the admin from ADMIN_EMAIL / ADMIN_PASSWORD so a reviewer login always works. */
export async function seedAdmin(): Promise<void> {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) return;
  const hash = await hashPassword(config.ADMIN_PASSWORD);
  await query(
    `INSERT INTO admins (email, password_hash) VALUES (lower($1), $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [config.ADMIN_EMAIL, hash],
  );
  logger.info({ email: config.ADMIN_EMAIL.toLowerCase() }, 'seed admin ensured');
}

// ---- brute-force protection for login (per IP) ----
const attempts = new Map<string, { count: number; resetAt: number }>();
function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
    return false;
  }
  a.count++;
  return a.count > 10;
}

function safeNext(raw: unknown): string {
  const next = typeof raw === 'string' ? raw : '';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/dashboard';
}

// A fixed dummy hash so unknown emails take as long as wrong passwords (no user enumeration by timing).
const dummyHash = hashPassword(randomToken());

export function authRouter(): Router {
  const r = Router();

  r.get('/login', (req, res) => {
    if (req.session) return res.redirect('/dashboard');
    res.send(authPage({ mode: 'login', next: safeNext(req.query.next), allowSignup: config.ALLOW_SIGNUP }).value);
  });

  r.post('/login', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const next = safeNext(req.body?.next);
    const ip = req.ip ?? 'unknown';
    if (tooManyAttempts(ip)) {
      res.status(429).send(authPage({ mode: 'login', next, allowSignup: config.ALLOW_SIGNUP, error: 'Too many attempts. Try again in 15 minutes.', email }).value);
      return;
    }
    const { rows } = await query<{ id: number; password_hash: string }>('SELECT id, password_hash FROM admins WHERE email = $1', [email]);
    const admin = rows[0];
    const ok = await verifyPassword(password, admin?.password_hash ?? (await dummyHash));
    if (!admin || !ok) {
      logger.warn({ kind: 'auth.failed' }, 'failed admin login');
      res.status(401).send(authPage({ mode: 'login', next, allowSignup: config.ALLOW_SIGNUP, error: 'Wrong email or password.', email }).value);
      return;
    }
    attempts.delete(ip);
    await createSession(res, admin.id);
    res.redirect(next);
  });

  r.get('/signup', (req, res) => {
    if (!config.ALLOW_SIGNUP) return res.redirect('/login');
    res.send(authPage({ mode: 'signup', next: '/dashboard', allowSignup: true }).value);
  });

  r.post('/signup', async (req, res) => {
    if (!config.ALLOW_SIGNUP) return res.redirect('/login');
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const fail = (error: string) => res.status(400).send(authPage({ mode: 'signup', next: '/dashboard', allowSignup: true, error, email }).value);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return fail('Enter a valid email address.');
    if (password.length < 8 || password.length > 200) return fail('Password must be at least 8 characters.');
    if (tooManyAttempts(req.ip ?? 'unknown')) return fail('Too many attempts. Try again later.');
    const ins = await query<{ id: number }>('INSERT INTO admins (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id', [
      email,
      await hashPassword(password),
    ]);
    const id = ins.rows[0]?.id;
    if (!id) return fail('An account with that email already exists.');
    await createSession(res, id);
    res.redirect('/dashboard');
  });

  r.post('/logout', requireAuth, requireCsrf, async (req, res) => {
    await query('DELETE FROM sessions WHERE id_hash = $1', [req.session!.idHash]);
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect('/login');
  });

  return r;
}

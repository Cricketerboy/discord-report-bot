import { Router, type Request, type Response } from 'express';
import { query } from '../db/pool.js';
import { bus } from '../services/events.js';
import { adminCanAccessGuild, guildIdsForAdmin } from '../services/guilds.js';
import { requireAuth } from './auth.js';

async function guard(req: Request, res: Response): Promise<string | null> {
  const guildId = String(req.params.guildId ?? '');
  if (!/^\d{15,25}$/.test(guildId) || !(await adminCanAccessGuild(req.session!.adminId, guildId))) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return guildId;
}

export function apiRouter(): Router {
  const r = Router();
  r.use('/api', requireAuth);
  r.use('/api', (_req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    next();
  });

  /** Interactions with the state of every action they triggered. Never includes tokens or webhook URLs. */
  r.get('/api/g/:guildId/activity', async (req, res) => {
    const guildId = await guard(req, res);
    if (!guildId) return;
    const interactions = await query<{
      id: string;
      type: number;
      command: string | null;
      user_name: string | null;
      input: string | null;
      outcome: string;
      response_type: number | null;
      response_ms: number | null;
      spooled: boolean;
      received_at: Date;
    }>(
      `SELECT id, type, command, user_name, input, outcome, response_type, response_ms, spooled, received_at
         FROM interactions WHERE guild_id = $1 ORDER BY received_at DESC LIMIT 60`,
      [guildId],
    );
    const ids = interactions.rows.map((i) => i.id);
    const [jobs, reports] = ids.length
      ? await Promise.all([
          query<{ interaction_id: string; kind: string; status: string; attempts: number; max_attempts: number; last_error: string | null }>(
            'SELECT interaction_id, kind, status, attempts, max_attempts, last_error FROM jobs WHERE interaction_id = ANY($1::text[]) ORDER BY id',
            [ids],
          ),
          query<{ interaction_id: string; id: number; severity: string; category: string; summary: string | null; status: string; ai_status: string }>(
            'SELECT interaction_id, id, severity, category, summary, status, ai_status FROM reports WHERE interaction_id = ANY($1::text[])',
            [ids],
          ),
        ])
      : [{ rows: [] }, { rows: [] }];

    res.json({
      items: interactions.rows.map((i) => ({
        id: i.id,
        type: i.type,
        command: i.command,
        userName: i.user_name,
        input: i.input,
        outcome: i.outcome,
        responseType: i.response_type,
        responseMs: i.response_ms,
        spooled: i.spooled,
        receivedAt: i.received_at,
        jobs: jobs.rows
          .filter((j) => j.interaction_id === i.id)
          .map((j) => ({ kind: j.kind, status: j.status, attempts: j.attempts, maxAttempts: j.max_attempts, lastError: j.last_error })),
        report: reports.rows.find((rep) => rep.interaction_id === i.id) ?? null,
      })),
    });
  });

  r.get('/api/g/:guildId/events', async (req, res) => {
    const guildId = await guard(req, res);
    if (!guildId) return;
    const { rows } = await query(
      'SELECT id, interaction_id, level, kind, message, created_at FROM events WHERE guild_id = $1 ORDER BY id DESC LIMIT 80',
      [guildId],
    );
    res.json({ items: rows });
  });

  /** Server-Sent Events: pushes a "something changed in guild X" hint; the page then refetches. */
  r.get('/api/stream', async (req, res) => {
    const allowed = new Set(await guildIdsForAdmin(req.session!.adminId));
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const onChange = (e: { guildId: string | null }) => {
      if (e.guildId && !allowed.has(e.guildId)) return;
      res.write(`event: change\ndata: ${JSON.stringify({ guildId: e.guildId })}\n\n`);
    };
    bus.on('change', onChange);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      bus.off('change', onChange);
    });
  });

  return r;
}

import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import type { GuildConfig } from '../domain.js';
import { getGuildChannels, getGuildRoles, leaveGuild, overwriteGuildCommands, type DiscordChannel, type DiscordRole } from '../discord/api.js';
import { COMMANDS } from '../discord/commands.js';
import { retryJob } from '../jobs/queue.js';
import { errorMessage } from '../lib/redact.js';
import { spool } from '../interactions/spool.js';
import { recordEvent } from '../services/events.js';
import {
  addRule,
  adminCanAccessGuild,
  deleteGuild,
  deleteRule,
  getGuildConfig,
  getMirrorWebhook,
  listGuildsForAdmin,
  markCommandsSynced,
  moveRule,
  setAlertRole,
  setMirrorWebhook,
  setReportChannel,
  toggleRule,
  updateSettings,
} from '../services/guilds.js';
import { sendMirror } from '../services/mirror.js';
import { toReport } from '../services/reports.js';
import { validateRule } from '../services/rules.js';
import { securitySnapshot } from '../services/security.js';
import { requireAuth, requireCsrf } from './auth.js';
import {
  activityBody,
  errorPage,
  failuresBody,
  guildLayout,
  interactionDetailBody,
  overviewPage,
  reportsBody,
  rulesBody,
  settingsBody,
  type FailureRow,
  type Flash,
} from './views.js';

declare module 'express-serve-static-core' {
  interface Request {
    guildCfg?: GuildConfig;
  }
}

function flashFrom(req: Request): Flash {
  const pick = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : undefined);
  return { ok: pick(req.query.ok), err: pick(req.query.err) };
}

function back(res: Response, path: string, flash: Flash): void {
  const q = new URLSearchParams();
  if (flash.ok) q.set('ok', flash.ok);
  if (flash.err) q.set('err', flash.err);
  res.redirect(`${path}${q.size ? `?${q.toString()}` : ''}`);
}

/** Multi-tenant isolation: every /dashboard/g/:guildId route checks the admin is linked to that guild. */
async function loadGuild(req: Request, res: Response, next: NextFunction): Promise<void> {
  const guildId = String(req.params.guildId ?? '');
  if (!/^\d{15,25}$/.test(guildId) || !(await adminCanAccessGuild(req.session!.adminId, guildId))) {
    res.status(404).send(errorPage(404, 'Server not found, or you do not have access to it.', req.session));
    return;
  }
  const cfg = await getGuildConfig(guildId, { fresh: true });
  if (!cfg) {
    res.status(404).send(errorPage(404, 'Server not found.', req.session));
    return;
  }
  req.guildCfg = cfg;
  next();
}

async function failureCount(guildId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(`SELECT count(*) AS n FROM jobs WHERE guild_id = $1 AND (status = 'dead' OR (status = 'pending' AND attempts > 0))`, [guildId]);
  return Number(rows[0]?.n ?? 0);
}

async function discordLists(guildId: string): Promise<{ channels: DiscordChannel[]; roles: DiscordRole[]; error?: string }> {
  try {
    const [channels, roles] = await Promise.all([getGuildChannels(guildId), getGuildRoles(guildId)]);
    return {
      // 0 = text, 5 = announcement
      channels: channels.filter((c) => c.type === 0 || c.type === 5).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
      roles: roles.filter((r) => r.name !== '@everyone' && !r.managed).sort((a, b) => (b.position ?? 0) - (a.position ?? 0)),
    };
  } catch (err) {
    return { channels: [], roles: [], error: errorMessage(err) };
  }
}

export async function syncCommands(guildId: string): Promise<void> {
  await overwriteGuildCommands(guildId, [...COMMANDS]);
  await markCommandsSynced(guildId);
  await recordEvent({ guildId, kind: 'commands.synced', message: `Registered ${COMMANDS.map((c) => `/${c.name}`).join(', ')}` });
}

export function dashboardRouter(): Router {
  const r = Router();
  r.use('/dashboard', requireAuth);

  r.get('/dashboard', async (req, res) => {
    const guilds = await listGuildsForAdmin(req.session!.adminId);
    res.send(
      overviewPage({
        session: req.session!,
        guilds,
        security: securitySnapshot(),
        spoolSize: spool.size,
        aiConfigured: Boolean(config.GROQ_API_KEY),
        flash: flashFrom(req),
      }).value,
    );
  });

  const g = Router({ mergeParams: true });
  r.use('/dashboard/g/:guildId', loadGuild, g);

  g.get('/', async (req, res) => {
    const cfg = req.guildCfg!;
    res.send(guildLayout({ session: req.session!, cfg, tab: 'activity', body: activityBody(cfg), flash: flashFrom(req), failures: await failureCount(cfg.id) }).value);
  });

  g.get('/reports', async (req, res) => {
    const cfg = req.guildCfg!;
    const { rows } = await query('SELECT * FROM reports WHERE guild_id = $1 ORDER BY id DESC LIMIT 200', [cfg.id]);
    res.send(
      guildLayout({ session: req.session!, cfg, tab: 'reports', body: reportsBody(rows.map((row) => toReport(row as never))), flash: flashFrom(req), failures: await failureCount(cfg.id) })
        .value,
    );
  });

  g.get('/rules', async (req, res) => {
    const cfg = req.guildCfg!;
    const { roles } = await discordLists(cfg.id);
    res.send(guildLayout({ session: req.session!, cfg, tab: 'rules', body: rulesBody({ session: req.session!, cfg, roles }), flash: flashFrom(req), failures: await failureCount(cfg.id) }).value);
  });

  g.get('/settings', async (req, res) => {
    const cfg = req.guildCfg!;
    const lists = await discordLists(cfg.id);
    res.send(
      guildLayout({
        session: req.session!,
        cfg,
        tab: 'settings',
        body: settingsBody({ session: req.session!, cfg, channels: lists.channels, roles: lists.roles, discordError: lists.error }),
        flash: flashFrom(req),
        failures: await failureCount(cfg.id),
      }).value,
    );
  });

  g.get('/failures', async (req, res) => {
    const cfg = req.guildCfg!;
    const jobs = await query<FailureRow>(
      `SELECT id, kind, status, attempts, max_attempts, last_error, run_at, updated_at, interaction_id FROM jobs
        WHERE guild_id = $1 AND (status = 'dead' OR (status = 'pending' AND attempts > 0))
        ORDER BY updated_at DESC LIMIT 100`,
      [cfg.id],
    );
    const events = await query<{ created_at: Date; level: string; kind: string; message: string }>(
      `SELECT created_at, level, kind, message FROM events WHERE guild_id = $1 AND level IN ('warn','error') ORDER BY id DESC LIMIT 50`,
      [cfg.id],
    );
    res.send(
      guildLayout({
        session: req.session!,
        cfg,
        tab: 'failures',
        body: failuresBody({ session: req.session!, cfg, jobs: jobs.rows, events: events.rows }),
        flash: flashFrom(req),
        failures: jobs.rowCount ?? 0,
      }).value,
    );
  });

  g.get('/i/:interactionId', async (req, res) => {
    const cfg = req.guildCfg!;
    const id = String(req.params.interactionId);
    const i = await query('SELECT id, command, user_name, input, outcome, received_at, response_type, response_ms, spooled FROM interactions WHERE id = $1 AND guild_id = $2', [id, cfg.id]);
    if (!i.rows[0]) {
      res.status(404).send(errorPage(404, 'Interaction not found.', req.session));
      return;
    }
    const [jobs, events, report] = await Promise.all([
      query<FailureRow>('SELECT id, kind, status, attempts, max_attempts, last_error, run_at, updated_at, interaction_id FROM jobs WHERE interaction_id = $1 ORDER BY id', [id]),
      query<{ created_at: Date; level: string; kind: string; message: string }>('SELECT created_at, level, kind, message FROM events WHERE interaction_id = $1 ORDER BY id', [id]),
      query('SELECT * FROM reports WHERE interaction_id = $1', [id]),
    ]);
    res.send(
      guildLayout({
        session: req.session!,
        cfg,
        tab: 'activity',
        body: interactionDetailBody({ cfg, interaction: i.rows[0] as never, jobs: jobs.rows, events: events.rows, report: report.rows[0] ? toReport(report.rows[0] as never) : null }),
        failures: await failureCount(cfg.id),
      }).value,
    );
  });

  // ---- mutations (all CSRF-protected) ----

  g.post('/settings/channel', requireCsrf, async (req, res) => {
    const cfg = req.guildCfg!;
    const path = `/dashboard/g/${cfg.id}/settings`;
    const channelId = String(req.body.channelId ?? '');
    const alertRoleId = String(req.body.alertRoleId ?? '');
    const lists = await discordLists(cfg.id);
    if (lists.error) return back(res, path, { err: `Discord API error: ${lists.error}` });
    const channel = channelId ? lists.channels.find((c) => c.id === channelId) : null;
    if (channelId && !channel) return back(res, path, { err: 'That channel is not a text channel in this server.' });
    if (alertRoleId && !lists.roles.some((ro) => ro.id === alertRoleId)) return back(res, path, { err: 'Unknown role.' });
    await setReportChannel(cfg.id, channel ? { id: channel.id, name: channel.name } : null);
    await setAlertRole(cfg.id, alertRoleId || null);
    await recordEvent({ guildId: cfg.id, kind: 'config.changed', message: `Report channel set to ${channel ? `#${channel.name}` : 'none'}` });
    back(res, path, { ok: 'Channel settings saved.' });
  });

  g.post('/settings/mirror', requireCsrf, async (req, res) => {
    const cfg = req.guildCfg!;
    const path = `/dashboard/g/${cfg.id}/settings`;
    const result = await setMirrorWebhook(cfg.id, String(req.body.webhookUrl ?? ''));
    if (!result.ok) return back(res, path, { err: result.error });
    await recordEvent({ guildId: cfg.id, kind: 'config.changed', message: 'Mirror webhook updated' });
    back(res, path, { ok: 'Mirror webhook saved (encrypted). Use “Send test message” to verify it.' });
  });

  g.post('/settings/mirror/remove', requireCsrf, async (req, res) => {
    const cfg = req.guildCfg!;
    await setMirrorWebhook(cfg.id, null);
    await recordEvent({ guildId: cfg.id, kind: 'config.changed', message: 'Mirror webhook removed' });
    back(res, `/dashboard/g/${cfg.id}/settings`, { ok: 'Mirror webhook removed.' });
  });

  g.post('/settings/mirror/test', requireCsrf, async (req, res) => {
    const cfg = req.guildCfg!;
    const path = `/dashboard/g/${cfg.id}/settings`;
    const hook = await getMirrorWebhook(cfg.id);
    if (!hook) return back(res, path, { err: 'No mirror webhook configured.' });
    try {
      await sendMirror(hook.url, hook.kind, {
        title: `Test message from Report Bot (${cfg.name})`,
        body: 'If you can read this, mirroring works.',
        fields: [],
        color: 0x5865f2,
        footer: `Sent by ${req.session!.email}`,
      });
      back(res, path, { ok: `Test message delivered to ${hook.kind}.` });
    } catch (err) {
      back(res, path, { err: `Test failed: ${errorMessage(err)}` });
    }
  });

  g.post('/settings/commands', requireCsrf, async (req, res) => {
    const cfg = req.guildCfg!;
    const b = req.body as Record<string, string | undefined>;
    const on = (k: string) => b[k] === '1';
    await updateSettings(cfg.id, {
      commands: {
        report: { enabled: on('reportEnabled'), ephemeral: on('reportEphemeral'), cooldownSeconds: Number(b.reportCooldown ?? 0) || 0 },
        status: { enabled: on('statusEnabled'), ephemeral: on('statusEphemeral') },
      },
      aiEnabled: on('aiEnabled'),
      resolveRequiresManageMessages: on('resolveRequiresManageMessages'),
      simulateMirrorFailures: Number(b.simulateMirrorFailures ?? 0) || 0,
    });
    await recordEvent({ guildId: cfg.id, kind: 'config.changed', message: 'Command behaviour updated' });
    back(res, `/dashboard/g/${cfg.id}/settings`, { ok: 'Command behaviour saved. It applies to the next interaction.' });
  });

  g.post('/settings/sync-commands', requireCsrf, async (req, res) => {
    const cfg = req.guildCfg!;
    try {
      await syncCommands(cfg.id);
      back(res, `/dashboard/g/${cfg.id}/settings`, { ok: 'Slash commands registered. They appear in Discord immediately (restart the Discord client if not).' });
    } catch (err) {
      back(res, `/dashboard/g/${cfg.id}/settings`, { err: `Could not register commands: ${errorMessage(err)}` });
    }
  });

  g.post('/settings/disconnect', requireCsrf, async (req, res) => {
    const cfg = req.guildCfg!;
    try {
      await leaveGuild(cfg.id);
    } catch {
      /* bot may already be gone; delete local data regardless */
    }
    await deleteGuild(cfg.id);
    back(res, '/dashboard', { ok: `Disconnected ${cfg.name}.` });
  });

  g.post('/rules', requireCsrf, async (req, res) => {
    const cfg = req.guildCfg!;
    const path = `/dashboard/g/${cfg.id}/rules`;
    const v = validateRule(req.body as Record<string, unknown>);
    if (!v.ok) return back(res, path, { err: v.error });
    await addRule(cfg.id, v.rule);
    back(res, path, { ok: 'Rule added.' });
  });

  g.post('/rules/:ruleId/toggle', requireCsrf, async (req, res) => {
    await toggleRule(req.guildCfg!.id, Number(req.params.ruleId));
    back(res, `/dashboard/g/${req.guildCfg!.id}/rules`, {});
  });

  g.post('/rules/:ruleId/delete', requireCsrf, async (req, res) => {
    await deleteRule(req.guildCfg!.id, Number(req.params.ruleId));
    back(res, `/dashboard/g/${req.guildCfg!.id}/rules`, { ok: 'Rule deleted.' });
  });

  g.post('/rules/:ruleId/move', requireCsrf, async (req, res) => {
    await moveRule(req.guildCfg!.id, Number(req.params.ruleId), req.body.direction === 'up' ? 'up' : 'down');
    back(res, `/dashboard/g/${req.guildCfg!.id}/rules`, {});
  });

  g.post('/jobs/:jobId/retry', requireCsrf, async (req, res) => {
    const cfg = req.guildCfg!;
    const ok = /^\d+$/.test(String(req.params.jobId)) && (await retryJob(String(req.params.jobId), cfg.id));
    back(res, `/dashboard/g/${cfg.id}/failures`, ok ? { ok: 'Retry scheduled.' } : { err: 'Job not found or not retryable.' });
  });

  return r;
}

import { pool, query, tx, type Queryable } from '../db/pool.js';
import { normalizeSettings, type GuildConfig, type GuildSettings, type Rule } from '../domain.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { withTimeout } from '../lib/http.js';
import { registerSecret } from '../lib/redact.js';
import { logger } from '../logger.js';
import { DEFAULT_RULES, type RuleDraft } from './rules.js';
import { classifyWebhookUrl, webhookHint } from './mirror.js';

interface GuildRow {
  id: string;
  name: string;
  icon: string | null;
  report_channel_id: string | null;
  report_channel_name: string | null;
  alert_role_id: string | null;
  mirror_kind: string | null;
  mirror_hint: string | null;
  settings: unknown;
  commands_synced_at: Date | null;
}

interface RuleRow {
  id: number;
  position: number;
  enabled: boolean;
  condition_type: string;
  condition_value: string;
  action_type: string;
  action_value: string;
}

function toRule(r: RuleRow): Rule {
  return {
    id: r.id,
    position: r.position,
    enabled: r.enabled,
    conditionType: r.condition_type,
    conditionValue: r.condition_value,
    actionType: r.action_type,
    actionValue: r.action_value,
  };
}

function toConfig(g: GuildRow, rules: RuleRow[]): GuildConfig {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    reportChannelId: g.report_channel_id,
    reportChannelName: g.report_channel_name,
    alertRoleId: g.alert_role_id,
    mirrorKind: g.mirror_kind,
    mirrorHint: g.mirror_hint,
    settings: normalizeSettings(g.settings),
    rules: rules.map(toRule),
    commandsSyncedAt: g.commands_synced_at,
  };
}

// ---- config cache: the interaction hot path reads from here so it rarely waits on the DB ----

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: GuildConfig | null; at: number }>();

export function invalidateGuild(guildId: string): void {
  cache.delete(guildId);
}

async function loadGuildConfig(guildId: string, db: Queryable = pool): Promise<GuildConfig | null> {
  const g = await db.query<GuildRow>(
    `SELECT id, name, icon, report_channel_id, report_channel_name, alert_role_id, mirror_kind, mirror_hint, settings, commands_synced_at
       FROM guilds WHERE id = $1`,
    [guildId],
  );
  const row = g.rows[0];
  if (!row) return null;
  const rules = await db.query<RuleRow>('SELECT * FROM rules WHERE guild_id = $1 ORDER BY position, id', [guildId]);
  return toConfig(row, rules.rows);
}

export async function getGuildConfig(guildId: string, opts: { fresh?: boolean } = {}): Promise<GuildConfig | null> {
  const hit = cache.get(guildId);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await loadGuildConfig(guildId);
  cache.set(guildId, { value, at: Date.now() });
  return value;
}

/**
 * Hot-path lookup with a hard time budget. Returns 'unknown' when the DB is too slow to answer in
 * time and nothing (even stale) is cached — callers then fall back to defaults and defer.
 */
export async function getGuildConfigFast(guildId: string, budgetMs: number): Promise<GuildConfig | null | 'unknown'> {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    return await withTimeout(getGuildConfig(guildId, { fresh: true }), budgetMs, 'guild config lookup');
  } catch (err) {
    if (hit) {
      logger.warn({ guildId }, 'guild config lookup slow/failed; using stale cache');
      return hit.value;
    }
    logger.warn({ guildId, err: err instanceof Error ? err.message : String(err) }, 'guild config unavailable');
    return 'unknown';
  }
}

export async function warmGuildCache(): Promise<void> {
  const { rows } = await query<{ id: string }>('SELECT id FROM guilds');
  await Promise.all(rows.map((r) => getGuildConfig(r.id, { fresh: true })));
}

// ---- access control ----

export async function adminCanAccessGuild(adminId: number, guildId: string): Promise<boolean> {
  const { rowCount } = await query('SELECT 1 FROM guild_admins WHERE admin_id = $1 AND guild_id = $2', [adminId, guildId]);
  return (rowCount ?? 0) > 0;
}

export async function guildIdsForAdmin(adminId: number): Promise<string[]> {
  const { rows } = await query<{ guild_id: string }>('SELECT guild_id FROM guild_admins WHERE admin_id = $1', [adminId]);
  return rows.map((r) => r.guild_id);
}

export interface GuildSummary extends GuildConfig {
  reportsOpen: number;
  interactions24h: number;
  deadJobs: number;
}

export async function listGuildsForAdmin(adminId: number): Promise<GuildSummary[]> {
  const ids = await guildIdsForAdmin(adminId);
  if (!ids.length) return [];
  const stats = await query<{ guild_id: string; reports_open: string; interactions_24h: string; dead_jobs: string }>(
    `SELECT g.id AS guild_id,
            (SELECT count(*) FROM reports r WHERE r.guild_id = g.id AND r.status <> 'resolved') AS reports_open,
            (SELECT count(*) FROM interactions i WHERE i.guild_id = g.id AND i.received_at > now() - interval '24 hours') AS interactions_24h,
            (SELECT count(*) FROM jobs j WHERE j.guild_id = g.id AND j.status = 'dead') AS dead_jobs
       FROM guilds g WHERE g.id = ANY($1::text[])`,
    [ids],
  );
  const out: GuildSummary[] = [];
  for (const s of stats.rows) {
    const cfg = await getGuildConfig(s.guild_id, { fresh: true });
    if (!cfg) continue;
    out.push({ ...cfg, reportsOpen: Number(s.reports_open), interactions24h: Number(s.interactions_24h), deadJobs: Number(s.dead_jobs) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- connect / disconnect ----

export async function connectGuild(guild: { id: string; name: string; icon: string | null }, adminId: number): Promise<{ isNew: boolean }> {
  const isNew = await tx(async (c) => {
    const ins = await c.query<{ inserted: boolean }>(
      `INSERT INTO guilds (id, name, icon, settings) VALUES ($1, $2, $3, '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [guild.id, guild.name, guild.icon],
    );
    await c.query('INSERT INTO guild_admins (guild_id, admin_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [guild.id, adminId]);
    const inserted = ins.rows[0]?.inserted ?? false;
    const existingRules = await c.query('SELECT 1 FROM rules WHERE guild_id = $1 LIMIT 1', [guild.id]);
    if (!existingRules.rowCount) {
      let pos = 0;
      for (const r of DEFAULT_RULES) await insertRule(c, guild.id, r, (pos += 10));
    }
    return inserted;
  });
  invalidateGuild(guild.id);
  return { isNew };
}

export async function deleteGuild(guildId: string): Promise<void> {
  await tx(async (c) => {
    await c.query('DELETE FROM jobs WHERE guild_id = $1', [guildId]);
    await c.query('DELETE FROM events WHERE guild_id = $1', [guildId]);
    await c.query('DELETE FROM interactions WHERE guild_id = $1', [guildId]);
    await c.query('DELETE FROM guilds WHERE id = $1', [guildId]);
  });
  invalidateGuild(guildId);
}

export async function markCommandsSynced(guildId: string): Promise<void> {
  await query('UPDATE guilds SET commands_synced_at = now(), updated_at = now() WHERE id = $1', [guildId]);
  invalidateGuild(guildId);
}

// ---- settings ----

export async function setReportChannel(guildId: string, channel: { id: string; name: string } | null): Promise<void> {
  await query('UPDATE guilds SET report_channel_id = $2, report_channel_name = $3, updated_at = now() WHERE id = $1', [
    guildId,
    channel?.id ?? null,
    channel?.name ?? null,
  ]);
  invalidateGuild(guildId);
}

export async function setAlertRole(guildId: string, roleId: string | null): Promise<void> {
  await query('UPDATE guilds SET alert_role_id = $2, updated_at = now() WHERE id = $1', [guildId, roleId]);
  invalidateGuild(guildId);
}

export async function setMirrorWebhook(guildId: string, rawUrl: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (rawUrl === null) {
    await query('UPDATE guilds SET mirror_webhook_enc = NULL, mirror_kind = NULL, mirror_hint = NULL, updated_at = now() WHERE id = $1', [guildId]);
    invalidateGuild(guildId);
    return { ok: true };
  }
  const kind = classifyWebhookUrl(rawUrl);
  if (!kind) return { ok: false, error: 'That is not a Slack Incoming Webhook or Discord channel webhook URL.' };
  await query('UPDATE guilds SET mirror_webhook_enc = $2, mirror_kind = $3, mirror_hint = $4, updated_at = now() WHERE id = $1', [
    guildId,
    encrypt(rawUrl.trim()),
    kind,
    webhookHint(rawUrl, kind),
  ]);
  invalidateGuild(guildId);
  return { ok: true };
}

/** Decrypted only at send time, and registered with the log scrubber before it can appear anywhere. */
export async function getMirrorWebhook(guildId: string): Promise<{ url: string; kind: 'slack' | 'discord' } | null> {
  const { rows } = await query<{ mirror_webhook_enc: string | null; mirror_kind: string | null }>(
    'SELECT mirror_webhook_enc, mirror_kind FROM guilds WHERE id = $1',
    [guildId],
  );
  const row = rows[0];
  if (!row?.mirror_webhook_enc || (row.mirror_kind !== 'slack' && row.mirror_kind !== 'discord')) return null;
  const url = decrypt(row.mirror_webhook_enc);
  registerSecret(url);
  return { url, kind: row.mirror_kind };
}

export async function updateSettings(guildId: string, settings: GuildSettings): Promise<void> {
  await query('UPDATE guilds SET settings = $2::jsonb, updated_at = now() WHERE id = $1', [guildId, JSON.stringify(normalizeSettings(settings))]);
  invalidateGuild(guildId);
}

/** Atomically consumes one simulated mirror failure. Returns true if this send should fail. */
export async function consumeSimulatedMirrorFailure(guildId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE guilds
        SET settings = jsonb_set(settings, '{simulateMirrorFailures}', to_jsonb((settings->>'simulateMirrorFailures')::int - 1))
      WHERE id = $1 AND COALESCE((settings->>'simulateMirrorFailures')::int, 0) > 0`,
    [guildId],
  );
  if (rowCount) invalidateGuild(guildId);
  return (rowCount ?? 0) > 0;
}

// ---- rules ----

async function insertRule(db: Queryable, guildId: string, r: RuleDraft, position: number): Promise<void> {
  await db.query(
    'INSERT INTO rules (guild_id, position, condition_type, condition_value, action_type, action_value) VALUES ($1,$2,$3,$4,$5,$6)',
    [guildId, position, r.conditionType, r.conditionValue, r.actionType, r.actionValue],
  );
}

export async function addRule(guildId: string, r: RuleDraft): Promise<void> {
  const { rows } = await query<{ max: number | null }>('SELECT max(position) AS max FROM rules WHERE guild_id = $1', [guildId]);
  await insertRule(pool, guildId, r, (rows[0]?.max ?? 0) + 10);
  invalidateGuild(guildId);
}

export async function toggleRule(guildId: string, ruleId: number): Promise<void> {
  await query('UPDATE rules SET enabled = NOT enabled WHERE id = $1 AND guild_id = $2', [ruleId, guildId]);
  invalidateGuild(guildId);
}

export async function deleteRule(guildId: string, ruleId: number): Promise<void> {
  await query('DELETE FROM rules WHERE id = $1 AND guild_id = $2', [ruleId, guildId]);
  invalidateGuild(guildId);
}

export async function moveRule(guildId: string, ruleId: number, direction: 'up' | 'down'): Promise<void> {
  await tx(async (c) => {
    const { rows } = await c.query<{ id: number }>('SELECT id FROM rules WHERE guild_id = $1 ORDER BY position, id FOR UPDATE', [guildId]);
    const ids = rows.map((r) => r.id);
    const i = ids.indexOf(ruleId);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    for (let k = 0; k < ids.length; k++) await c.query('UPDATE rules SET position = $1 WHERE id = $2', [(k + 1) * 10, ids[k]]);
  });
  invalidateGuild(guildId);
}

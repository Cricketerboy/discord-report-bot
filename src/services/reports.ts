import { pool, query, type Queryable } from '../db/pool.js';
import type { Report, ReportStatus } from '../domain.js';
import type { ReportAction } from '../discord/commands.js';
import type { TriageResult } from './triage.js';
import type { RuleOutcome } from './rules.js';

interface ReportRow {
  id: number;
  guild_id: string;
  interaction_id: string;
  channel_id: string | null;
  user_id: string | null;
  user_name: string | null;
  text: string;
  source: string;
  severity: Report['severity'];
  category: Report['category'];
  summary: string | null;
  tags: string[];
  ai_status: string;
  ai_model: string | null;
  matched_rules: Report['matchedRules'];
  mentions: string[];
  notes: string[];
  mirror: boolean;
  status: ReportStatus;
  status_by: string | null;
  status_at: Date | null;
  channel_message_id: string | null;
  created_at: Date;
}

export function toReport(r: ReportRow): Report {
  return {
    id: r.id,
    guildId: r.guild_id,
    interactionId: r.interaction_id,
    channelId: r.channel_id,
    userId: r.user_id,
    userName: r.user_name,
    text: r.text,
    source: r.source,
    severity: r.severity,
    category: r.category,
    summary: r.summary,
    tags: r.tags ?? [],
    aiStatus: r.ai_status,
    aiModel: r.ai_model,
    matchedRules: r.matched_rules ?? [],
    mentions: r.mentions ?? [],
    notes: r.notes ?? [],
    mirror: r.mirror,
    status: r.status,
    statusBy: r.status_by,
    statusAt: r.status_at,
    channelMessageId: r.channel_message_id,
    createdAt: r.created_at,
  };
}

export interface NewReport {
  guildId: string;
  interactionId: string;
  channelId: string | null;
  userId: string | null;
  userName: string | null;
  text: string;
  source: 'command' | 'modal';
}

/** Idempotent on interaction_id: a retried job gets the same report back. */
export async function createReportIfMissing(r: NewReport, db: Queryable = pool): Promise<Report> {
  await db.query(
    `INSERT INTO reports (guild_id, interaction_id, channel_id, user_id, user_name, text, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (interaction_id) DO NOTHING`,
    [r.guildId, r.interactionId, r.channelId, r.userId, r.userName, r.text, r.source],
  );
  const { rows } = await db.query<ReportRow>('SELECT * FROM reports WHERE interaction_id = $1', [r.interactionId]);
  return toReport(rows[0]!);
}

export async function getReport(id: number, db: Queryable = pool): Promise<Report | null> {
  const { rows } = await db.query<ReportRow>('SELECT * FROM reports WHERE id = $1', [id]);
  return rows[0] ? toReport(rows[0]) : null;
}

export async function applyTriage(reportId: number, t: TriageResult, outcome: RuleOutcome): Promise<Report> {
  const { rows } = await query<ReportRow>(
    `UPDATE reports SET severity = $2, category = $3, summary = $4, tags = $5, ai_status = $6, ai_model = $7,
            matched_rules = $8::jsonb, mentions = $9, notes = $10, mirror = $11, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [
      reportId,
      outcome.severity,
      t.triage.category,
      t.triage.summary,
      t.triage.tags,
      t.aiStatus,
      t.model,
      JSON.stringify(outcome.matched),
      outcome.mentionRoleIds,
      outcome.notes,
      outcome.mirror,
    ],
  );
  return toReport(rows[0]!);
}

export async function setChannelMessage(reportId: number, messageId: string): Promise<void> {
  await query('UPDATE reports SET channel_message_id = $2, updated_at = now() WHERE id = $1', [reportId, messageId]);
}

const TARGET: Record<ReportAction, ReportStatus> = { ack: 'acknowledged', resolve: 'resolved', reopen: 'open' };

/**
 * Conditional update: only changes the row if it isn't already in the target state, so a repeated
 * click (or a replayed/duplicated component interaction) reports `changed: false` and triggers nothing.
 * Scoped by guild so a custom_id can never touch another server's report.
 */
export async function changeReportStatus(
  db: Queryable,
  args: { reportId: number; guildId: string; action: ReportAction; by: string },
): Promise<{ report: Report | null; changed: boolean }> {
  const target = TARGET[args.action];
  const upd = await db.query<ReportRow>(
    `UPDATE reports SET status = $3, status_by = $4, status_at = now(), updated_at = now()
      WHERE id = $1 AND guild_id = $2 AND status <> $3 RETURNING *`,
    [args.reportId, args.guildId, target, args.by],
  );
  if (upd.rows[0]) return { report: toReport(upd.rows[0]), changed: true };
  const cur = await db.query<ReportRow>('SELECT * FROM reports WHERE id = $1 AND guild_id = $2', [args.reportId, args.guildId]);
  return { report: cur.rows[0] ? toReport(cur.rows[0]) : null, changed: false };
}

export interface StatusStats {
  open: number;
  acknowledged: number;
  resolved: number;
  last24h: number;
  pendingJobs: number;
  deadJobs: number;
  latest: { id: number; severity: string; summary: string | null; userName: string | null; createdAt: Date } | null;
}

export async function getStatusStats(guildId: string): Promise<StatusStats> {
  const { rows } = await query<{
    open: string;
    acknowledged: string;
    resolved: string;
    last24h: string;
    pending_jobs: string;
    dead_jobs: string;
    latest: { id: number; severity: string; summary: string | null; user_name: string | null; created_at: string } | null;
  }>(
    `SELECT
       (SELECT count(*) FROM reports WHERE guild_id = $1 AND status = 'open') AS open,
       (SELECT count(*) FROM reports WHERE guild_id = $1 AND status = 'acknowledged') AS acknowledged,
       (SELECT count(*) FROM reports WHERE guild_id = $1 AND status = 'resolved') AS resolved,
       (SELECT count(*) FROM reports WHERE guild_id = $1 AND created_at > now() - interval '24 hours') AS last24h,
       (SELECT count(*) FROM jobs WHERE guild_id = $1 AND status IN ('pending','running')) AS pending_jobs,
       (SELECT count(*) FROM jobs WHERE guild_id = $1 AND status = 'dead') AS dead_jobs,
       (SELECT row_to_json(x) FROM (SELECT id, severity, summary, user_name, created_at FROM reports
          WHERE guild_id = $1 ORDER BY id DESC LIMIT 1) x) AS latest`,
    [guildId],
  );
  const r = rows[0]!;
  return {
    open: Number(r.open),
    acknowledged: Number(r.acknowledged),
    resolved: Number(r.resolved),
    last24h: Number(r.last24h),
    pendingJobs: Number(r.pending_jobs),
    deadJobs: Number(r.dead_jobs),
    latest: r.latest
      ? { id: r.latest.id, severity: r.latest.severity, summary: r.latest.summary, userName: r.latest.user_name, createdAt: new Date(r.latest.created_at) }
      : null,
  };
}

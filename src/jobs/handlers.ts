import { pool, query, tx } from '../db/pool.js';
import type { ReportStatus } from '../domain.js';
import { createChannelMessage, editOriginalResponse } from '../discord/api.js';
import type { ReportAction } from '../discord/commands.js';
import { mirrorForReport, mirrorForStatusChange, reportCard, reportReply, statusMessage } from '../discord/messages.js';
import { snowflakeTime, type MessageBody } from '../discord/types.js';
import { JobError } from '../lib/http.js';
import { applyReportAction } from '../services/actions.js';
import { recordEvent } from '../services/events.js';
import { consumeSimulatedMirrorFailure, getGuildConfig, getMirrorWebhook } from '../services/guilds.js';
import { sendMirror } from '../services/mirror.js';
import { applyTriage, createReportIfMissing, getReport, getStatusStats, setChannelMessage } from '../services/reports.js';
import { evaluateRules } from '../services/rules.js';
import { triage } from '../services/triage.js';
import { enqueue, wakeWorker, type JobKind, type JobRow } from './queue.js';

const TOKEN_LIFETIME_MS = 15 * 60_000;

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new JobError(`${what} not found`, false);
  return value;
}

/** Interaction tokens are only valid for 15 minutes; past that, retrying can't succeed. */
async function interactionToken(interactionId: string): Promise<string> {
  if (Date.now() > snowflakeTime(interactionId).getTime() + TOKEN_LIFETIME_MS - 5000) {
    throw new JobError('interaction token expired (Discord allows follow-ups for 15 minutes)', false);
  }
  const { rows } = await query<{ token: string }>('SELECT token FROM interactions WHERE id = $1', [interactionId]);
  return need(rows[0]?.token, 'interaction');
}

interface ReportProcessPayload {
  text: string;
  source: 'command' | 'modal';
  userId: string | null;
  userName: string | null;
  channelId: string | null;
}

async function reportProcess(job: JobRow): Promise<void> {
  const p = job.payload as unknown as ReportProcessPayload;
  const guildId = need(job.guild_id, 'guild id');
  const interactionId = need(job.interaction_id, 'interaction id');
  const cfg = await getGuildConfig(guildId, { fresh: true });

  if (!cfg) {
    await enqueue(pool, {
      kind: 'discord.reply',
      dedupeKey: `discord.reply:${interactionId}`,
      guildId,
      interactionId,
      payload: { message: { content: 'This server was disconnected from the dashboard, so the report was not filed.', allowed_mentions: { parse: [] } } },
    });
    wakeWorker();
    return;
  }

  let report = await createReportIfMissing({ guildId, interactionId, channelId: p.channelId, userId: p.userId, userName: p.userName, text: p.text, source: p.source });

  // Triage + rules run once; a retry of this job after they succeeded skips straight to fan-out.
  if (report.aiStatus === 'pending') {
    const t = await triage(report.text, cfg.settings.aiEnabled);
    if (t.aiStatus === 'fallback') {
      await recordEvent({ guildId, interactionId, level: 'warn', kind: 'ai.fallback', message: `AI triage failed, used keyword triage: ${t.error ?? 'unknown error'}` });
    }
    const outcome = evaluateRules(cfg.rules, { text: report.text, severity: t.triage.severity, category: t.triage.category }, { alertRoleId: cfg.alertRoleId });
    report = await applyTriage(report.id, t, outcome);
    await recordEvent({
      guildId,
      interactionId,
      kind: 'report.triaged',
      message: `Report #${report.id}: ${report.severity}/${report.category} (triage: ${report.aiStatus}); ${outcome.matched.length} rule(s) matched`,
      data: { reportId: report.id, rules: outcome.matched.map((m) => m.description), mirror: outcome.mirror },
    });
  }

  // Fan out: every downstream action is its own job so each retries (and fails) independently.
  await tx(async (c) => {
    await enqueue(c, { kind: 'discord.reply', dedupeKey: `discord.reply:${interactionId}`, guildId, interactionId, payload: { reportId: report.id } });
    if (cfg.reportChannelId) {
      await enqueue(c, { kind: 'discord.post_report', dedupeKey: `discord.post_report:${report.id}`, guildId, interactionId, payload: { reportId: report.id } });
    }
    if (report.mirror) {
      await enqueue(c, { kind: 'mirror.send', dedupeKey: `mirror.send:report:${report.id}`, guildId, interactionId, payload: { reportId: report.id, event: 'created' } });
    }
  });
  if (!cfg.reportChannelId) {
    await recordEvent({ guildId, interactionId, level: 'warn', kind: 'config.no_channel', message: 'No report channel configured; buttons were attached to the reply instead.' });
  }
  wakeWorker();
}

async function discordReply(job: JobRow): Promise<void> {
  const interactionId = need(job.interaction_id, 'interaction id');
  const token = await interactionToken(interactionId);
  const { reportId, message } = job.payload as { reportId?: number; message?: MessageBody };
  let body: MessageBody;
  if (reportId) {
    const report = need(await getReport(reportId), `report #${reportId}`);
    const cfg = need(await getGuildConfig(report.guildId), 'guild');
    body = reportReply(report, cfg);
  } else {
    body = need(message, 'reply message');
  }
  await editOriginalResponse(token, body);
  await recordEvent({ guildId: job.guild_id, interactionId, kind: 'discord.replied', message: reportId ? `Replied to reporter for report #${reportId}` : 'Replied to user' });
}

async function discordPostReport(job: JobRow): Promise<void> {
  const { reportId } = job.payload as { reportId: number };
  const report = need(await getReport(reportId), `report #${reportId}`);
  if (report.channelMessageId) return; // already posted by an earlier attempt
  const cfg = need(await getGuildConfig(report.guildId, { fresh: true }), 'guild');
  if (!cfg.reportChannelId) return;
  // The nonce makes this POST idempotent on Discord's side if a previous attempt's response was lost.
  const msg = await createChannelMessage(cfg.reportChannelId, reportCard(report, { ping: true }), report.interactionId);
  await setChannelMessage(report.id, msg.id);
  await recordEvent({
    guildId: report.guildId,
    interactionId: job.interaction_id,
    kind: 'discord.posted',
    message: `Posted report #${report.id} to #${cfg.reportChannelName ?? cfg.reportChannelId}${report.mentions.length ? ` (pinged ${report.mentions.length} role(s))` : ''}`,
  });
}

async function mirrorSend(job: JobRow): Promise<void> {
  const p = job.payload as { reportId: number; event: 'created' | 'status'; status?: ReportStatus; by?: string };
  const report = need(await getReport(p.reportId), `report #${p.reportId}`);
  const cfg = need(await getGuildConfig(report.guildId), 'guild');
  const hook = await getMirrorWebhook(report.guildId);
  if (!hook) {
    await recordEvent({ guildId: report.guildId, interactionId: job.interaction_id, level: 'warn', kind: 'mirror.not_configured', message: 'Mirror skipped: no mirror webhook configured for this server.' });
    return;
  }
  if (await consumeSimulatedMirrorFailure(report.guildId)) {
    throw new JobError('simulated mirror outage (fault injection enabled in dashboard)', true);
  }
  const msg =
    p.event === 'status'
      ? mirrorForStatusChange({ ...report, status: p.status ?? report.status, statusBy: p.by ?? report.statusBy }, cfg.name)
      : mirrorForReport(report, cfg.name);
  await sendMirror(hook.url, hook.kind, msg);
  await recordEvent({ guildId: report.guildId, interactionId: job.interaction_id, kind: 'mirror.sent', message: `Mirrored ${p.event === 'status' ? `status change (${p.status})` : 'new report'} #${report.id} to ${hook.kind}` });
}

async function statusReply(job: JobRow): Promise<void> {
  const interactionId = need(job.interaction_id, 'interaction id');
  const guildId = need(job.guild_id, 'guild id');
  const token = await interactionToken(interactionId);
  const [stats, cfg] = await Promise.all([getStatusStats(guildId), getGuildConfig(guildId)]);
  const { flags: _ignored, ...body } = statusMessage(stats, cfg, false);
  await editOriginalResponse(token, body);
}

async function componentApply(job: JobRow): Promise<void> {
  const interactionId = need(job.interaction_id, 'interaction id');
  const guildId = need(job.guild_id, 'guild id');
  const p = job.payload as { reportId: number; action: ReportAction; by: string };
  const token = await interactionToken(interactionId);
  const { report, changed } = await tx((c) => applyReportAction(c, { ...p, guildId, interactionId }));
  const found = need(report, `report #${p.reportId}`);
  const card = reportCard(found, { ping: false });
  await editOriginalResponse(token, { embeds: card.embeds, components: card.components, allowed_mentions: { parse: [] } });
  if (changed) {
    await recordEvent({ guildId, interactionId, kind: 'report.status_changed', message: `Report #${found.id} → ${found.status} by ${p.by}` });
    wakeWorker();
  }
}

export const handlers: Record<JobKind, (job: JobRow) => Promise<void>> = {
  'report.process': reportProcess,
  'discord.reply': discordReply,
  'discord.post_report': discordPostReport,
  'mirror.send': mirrorSend,
  'status.reply': statusReply,
  'component.apply': componentApply,
};

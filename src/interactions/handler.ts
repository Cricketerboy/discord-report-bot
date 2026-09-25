import { config } from '../config.js';
import { DEFAULT_SETTINGS, type GuildConfig, type GuildSettings } from '../domain.js';
import { parseReportButtonId, REPORT_MODAL_ID, REPORT_MODAL_INPUT_ID, reportModal } from '../discord/commands.js';
import { ephemeral, reportCard, statusMessage } from '../discord/messages.js';
import {
  displayName,
  findModalValue,
  hasPermission,
  interactionUser,
  InteractionType,
  MessageFlags,
  Permissions,
  ResponseType,
  type Interaction,
} from '../discord/types.js';
import { Deadline, withTimeout } from '../lib/http.js';
import { logger } from '../logger.js';
import { refreshInteractionOutcome, wakeWorker, type JobSpec } from '../jobs/queue.js';
import { applyReportAction } from '../services/actions.js';
import { recordEvent } from '../services/events.js';
import { getGuildConfigFast } from '../services/guilds.js';
import { getStatusStats } from '../services/reports.js';
import { alreadySeen, enqueueOrSpool, ingest, markInteractionCompleted, markSeen, recordBestEffort } from './ingest.js';
import { toRecord } from './records.js';

export interface InteractionResponse {
  type: number;
  data?: object;
}

// Per-step caps; the shared Deadline keeps the sum well inside Discord's 3s window.
const CONFIG_BUDGET_MS = 700;
const INGEST_BUDGET_MS = 1200;
const INLINE_BUDGET_MS = 1200;

const DUPLICATE = ephemeral('This interaction was already received — ignoring the duplicate delivery.');

// ---- per-user cooldown for /report (a simple rule; in-memory is fine for a single instance) ----
const lastReportAt = new Map<string, number>();
function cooldownRemaining(guildId: string, userId: string, seconds: number): number {
  const at = lastReportAt.get(`${guildId}:${userId}`);
  if (!at || seconds <= 0) return 0;
  return Math.max(0, Math.ceil((at + seconds * 1000 - Date.now()) / 1000));
}
function touchCooldown(guildId: string, userId: string): void {
  lastReportAt.set(`${guildId}:${userId}`, Date.now());
  if (lastReportAt.size > 5000) lastReportAt.clear();
}

function notConnected(): InteractionResponse {
  return ephemeral(`This server isn't connected to the dashboard yet. An admin can connect it at ${config.baseUrl}`);
}

export async function handleInteraction(i: Interaction, deadline: Deadline): Promise<InteractionResponse> {
  if (i.type === InteractionType.PING) return { type: ResponseType.PONG };

  if (alreadySeen(i.id)) {
    logger.warn({ interactionId: i.id }, 'duplicate interaction delivery (in-memory dedup)');
    return DUPLICATE;
  }
  markSeen(i.id);

  if (!i.guild_id) return ephemeral('Please use this bot inside a server.');

  const lookup = await getGuildConfigFast(i.guild_id, deadline.cap(CONFIG_BUDGET_MS));
  if (lookup === null) {
    logger.info({ guildId: i.guild_id }, 'interaction from a guild that is not connected');
    return notConnected();
  }
  // DB too slow to tell us the config: continue with defaults; the jobs re-read config later anyway.
  const cfg = lookup === 'unknown' ? null : lookup;
  const settings = cfg?.settings ?? DEFAULT_SETTINGS;

  switch (i.type) {
    case InteractionType.APPLICATION_COMMAND:
      if (i.data?.name === 'report') return onReportCommand(i, settings, deadline);
      if (i.data?.name === 'status') return onStatusCommand(i, cfg, settings, deadline);
      return ephemeral('Unknown command. Try /report or /status.');
    case InteractionType.MODAL_SUBMIT:
      return onModalSubmit(i, settings, deadline);
    case InteractionType.MESSAGE_COMPONENT:
      return onComponent(i, settings, deadline);
    case InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE:
      return { type: 8, data: { choices: [] } };
    default:
      return ephemeral('Unsupported interaction type.');
  }
}

function reject(i: Interaction, command: string, input: string | null, message: string): InteractionResponse {
  recordBestEffort(toRecord(i, command, input, 'rejected'));
  return ephemeral(message);
}

function reportGate(i: Interaction, settings: GuildSettings, input: string | null): InteractionResponse | null {
  if (!settings.commands.report.enabled) return reject(i, 'report', input, '`/report` is currently disabled by the server admins.');
  const userId = interactionUser(i)?.id ?? 'unknown';
  const wait = cooldownRemaining(i.guild_id!, userId, settings.commands.report.cooldownSeconds);
  if (wait > 0) return reject(i, 'report', input, `You're filing reports too quickly — try again in ${wait}s.`);
  return null;
}

async function onReportCommand(i: Interaction, settings: GuildSettings, deadline: Deadline): Promise<InteractionResponse> {
  const raw = i.data?.options?.find((o) => o.name === 'text')?.value;
  const text = typeof raw === 'string' ? raw.trim() : '';
  const gate = reportGate(i, settings, text || null);
  if (gate) return gate;

  if (!text) {
    // No text: open a form (modal). A modal must be the *initial* response, so it can't be deferred.
    recordBestEffort(toRecord(i, 'report', null, 'completed'));
    return { type: ResponseType.MODAL, data: reportModal() };
  }
  return submitReport(i, text, 'command', settings, deadline);
}

async function onModalSubmit(i: Interaction, settings: GuildSettings, deadline: Deadline): Promise<InteractionResponse> {
  if (i.data?.custom_id !== REPORT_MODAL_ID) return ephemeral('Unknown form.');
  const text = findModalValue(i.data.components, REPORT_MODAL_INPUT_ID)?.trim() ?? '';
  if (!text) return ephemeral('Your report was empty, so nothing was filed.');
  const gate = reportGate(i, settings, text);
  if (gate) return gate;
  return submitReport(i, text, 'modal', settings, deadline);
}

/** Records the report durably, then defers: AI triage + posting happen in the job queue. */
async function submitReport(
  i: Interaction,
  text: string,
  source: 'command' | 'modal',
  settings: GuildSettings,
  deadline: Deadline,
): Promise<InteractionResponse> {
  const user = interactionUser(i);
  touchCooldown(i.guild_id!, user?.id ?? 'unknown');
  const job: JobSpec = {
    kind: 'report.process',
    dedupeKey: `report.process:${i.id}`,
    guildId: i.guild_id,
    interactionId: i.id,
    payload: { text: text.slice(0, 2000), source, userId: user?.id ?? null, userName: displayName(i), channelId: i.channel_id ?? null },
  };
  const result = await ingest(toRecord(i, source === 'modal' ? 'report (form)' : 'report', text), [job], {
    budgetMs: deadline.cap(INGEST_BUDGET_MS),
  });
  if (result.status === 'duplicate') return DUPLICATE;
  return {
    type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: settings.commands.report.ephemeral ? MessageFlags.EPHEMERAL : 0 },
  };
}

/** Fast path answers inline; if the DB is slow we defer and a job sends the answer instead. */
async function onStatusCommand(i: Interaction, cfg: GuildConfig | null, settings: GuildSettings, deadline: Deadline): Promise<InteractionResponse> {
  if (!settings.commands.status.enabled) return reject(i, 'status', null, '`/status` is currently disabled by the server admins.');
  const eph = settings.commands.status.ephemeral;
  const rec = toRecord(i, 'status', null);
  const job: JobSpec = { kind: 'status.reply', dedupeKey: `status.reply:${i.id}`, guildId: i.guild_id, interactionId: i.id };
  const deferred: InteractionResponse = {
    type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: eph ? MessageFlags.EPHEMERAL : 0 },
  };

  const result = await ingest(rec, [], { budgetMs: deadline.cap(INGEST_BUDGET_MS), spoolJobs: [job] });
  if (result.status === 'duplicate') return DUPLICATE;
  if (result.status === 'spooled') return deferred;

  try {
    const stats = await withTimeout(getStatusStats(i.guild_id!), deadline.cap(INLINE_BUDGET_MS), 'status stats');
    void markInteractionCompleted(i.id);
    return { type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { ...statusMessage(stats, cfg, eph) } };
  } catch {
    await enqueueOrSpool(rec, job, deadline.cap(600));
    return deferred;
  }
}

async function onComponent(i: Interaction, settings: GuildSettings, deadline: Deadline): Promise<InteractionResponse> {
  const parsed = parseReportButtonId(i.data?.custom_id);
  if (!parsed) return ephemeral('This button is no longer supported.');
  const input = `report #${parsed.reportId}`;
  const command = `button:${parsed.action}`;

  if (parsed.action !== 'ack' && settings.resolveRequiresManageMessages && !hasPermission(i, Permissions.MANAGE_MESSAGES)) {
    return reject(i, command, input, 'Only moderators (Manage Messages permission) can resolve or reopen reports.');
  }

  const by = displayName(i);
  const guildId = i.guild_id!;
  const job: JobSpec = {
    kind: 'component.apply',
    dedupeKey: `component.apply:${i.id}`,
    guildId,
    interactionId: i.id,
    payload: { reportId: parsed.reportId, action: parsed.action, by },
  };
  const result = await ingest(toRecord(i, command, input), [], {
    budgetMs: deadline.cap(INGEST_BUDGET_MS),
    extra: (c) => applyReportAction(c, { ...parsed, guildId, by, interactionId: i.id }),
    spoolJobs: [job],
  });
  if (result.status === 'duplicate') return DUPLICATE;
  // DB slow: acknowledge now ("deferred update"), the job edits the message when it can.
  if (result.status === 'spooled') return { type: ResponseType.DEFERRED_UPDATE_MESSAGE };

  const { report, changed } = result.value;
  if (!report) return ephemeral('That report no longer exists.');
  if (changed) {
    wakeWorker();
    void recordEvent({
      guildId,
      interactionId: i.id,
      kind: 'report.status_changed',
      message: `Report #${report.id} → ${report.status} by ${by}`,
    });
  }
  void refreshInteractionOutcome(i.id).catch(() => undefined);
  const card = reportCard(report, { ping: false });
  return { type: ResponseType.UPDATE_MESSAGE, data: { embeds: card.embeds, components: card.components, allowed_mentions: { parse: [] } } };
}

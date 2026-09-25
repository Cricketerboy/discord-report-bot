import type { GuildConfig, Report, Severity } from '../domain.js';
import type { StatusStats } from '../services/reports.js';
import type { MirrorMessage } from '../services/mirror.js';
import { reportButtonId, type ReportAction } from './commands.js';
import { MessageFlags, type MessageBody } from './types.js';

export const SEVERITY_COLOR: Record<Severity, number> = {
  low: 0x3ba55d,
  medium: 0xf0b232,
  high: 0xe67e22,
  critical: 0xed4245,
};

const SEVERITY_EMOJI: Record<Severity, string> = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };
const STATUS_LABEL = { open: '🆕 Open', acknowledged: '👀 Acknowledged', resolved: '✅ Resolved' } as const;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** User text is quoted; mentions are never parsed from it (see allowed_mentions on every message). */
function quote(text: string): string {
  return clip(text, 1500)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

function aiLine(r: Report): string {
  if (r.aiStatus === 'ok') return `AI triage: ${r.aiModel ?? 'LLM'}`;
  if (r.aiStatus === 'fallback') return 'AI unavailable – keyword triage used';
  if (r.aiStatus === 'disabled') return 'Keyword triage (AI off)';
  return 'Triage pending';
}

export function reportButtons(r: Report) {
  const btn = (action: ReportAction, label: string, style: number) => ({ type: 2, style, label, custom_id: reportButtonId(action, r.id) });
  const buttons =
    r.status === 'open'
      ? [btn('ack', 'Acknowledge', 1), btn('resolve', 'Resolve', 3)]
      : r.status === 'acknowledged'
        ? [btn('resolve', 'Resolve', 3)]
        : [btn('reopen', 'Reopen', 2)];
  return [{ type: 1, components: buttons }];
}

/** The moderator-facing card with action buttons. `ping` adds role mentions (only on first post). */
export function reportCard(r: Report, opts: { ping: boolean }): MessageBody {
  const statusValue = r.statusBy && r.status !== 'open' ? `${STATUS_LABEL[r.status]} by ${r.statusBy}` : STATUS_LABEL[r.status];
  const fields = [
    { name: 'Severity', value: `${SEVERITY_EMOJI[r.severity]} ${r.severity}`, inline: true },
    { name: 'Category', value: r.category, inline: true },
    { name: 'Status', value: statusValue, inline: true },
    { name: 'Reporter', value: r.userId ? `<@${r.userId}>` : (r.userName ?? 'unknown'), inline: true },
  ];
  if (r.summary) fields.push({ name: 'Summary', value: clip(r.summary, 1000), inline: false });
  if (r.tags.length) fields.push({ name: 'Tags', value: r.tags.map((t) => `\`${t}\``).join(' '), inline: false });
  if (r.matchedRules.length) fields.push({ name: 'Rules applied', value: clip(r.matchedRules.map((m) => `• ${m.description}`).join('\n'), 1000), inline: false });

  const mentions = opts.ping ? r.mentions : [];
  return {
    content: mentions.length ? `${mentions.map((id) => `<@&${id}>`).join(' ')} new **${r.severity}** report` : undefined,
    embeds: [
      {
        title: `Report #${r.id}`,
        description: quote(r.text),
        color: SEVERITY_COLOR[r.severity],
        fields,
        footer: { text: aiLine(r) },
        timestamp: new Date(r.createdAt).toISOString(),
      },
    ],
    components: reportButtons(r),
    allowed_mentions: { parse: [], roles: mentions },
  };
}

/** The reply the reporter sees. When no report channel is configured, the reply itself carries the buttons. */
export function reportReply(r: Report, cfg: GuildConfig): MessageBody {
  const fields = [
    { name: 'Severity', value: `${SEVERITY_EMOJI[r.severity]} ${r.severity}`, inline: true },
    { name: 'Category', value: r.category, inline: true },
  ];
  if (cfg.reportChannelId) fields.push({ name: 'Routed to', value: `<#${cfg.reportChannelId}>`, inline: true });
  for (const note of r.notes) fields.push({ name: 'Note', value: clip(note, 1000), inline: false });

  return {
    content: '',
    embeds: [
      {
        title: `Report #${r.id} received`,
        description: r.summary ? `**Summary:** ${clip(r.summary, 500)}` : quote(r.text),
        color: SEVERITY_COLOR[r.severity],
        fields,
        footer: { text: `${aiLine(r)} · Thanks for reporting!` },
      },
    ],
    components: cfg.reportChannelId ? [] : reportButtons(r),
    allowed_mentions: { parse: [] },
  };
}

export function statusMessage(stats: StatusStats, cfg: GuildConfig | null, ephemeral: boolean): MessageBody {
  const latest = stats.latest
    ? `#${stats.latest.id} · ${stats.latest.severity} · ${clip(stats.latest.summary ?? '', 120)} (<t:${Math.floor(stats.latest.createdAt.getTime() / 1000)}:R>)`
    : 'No reports yet';
  const health = stats.deadJobs > 0 ? `⚠️ ${stats.deadJobs} failed action(s) — see dashboard` : '✅ All actions delivered';
  return {
    embeds: [
      {
        title: `Status${cfg ? ` · ${cfg.name}` : ''}`,
        color: stats.open > 0 ? 0xf0b232 : 0x3ba55d,
        fields: [
          { name: 'Open', value: String(stats.open), inline: true },
          { name: 'Acknowledged', value: String(stats.acknowledged), inline: true },
          { name: 'Resolved', value: String(stats.resolved), inline: true },
          { name: 'Last 24h', value: String(stats.last24h), inline: true },
          { name: 'Queued actions', value: String(stats.pendingJobs), inline: true },
          { name: 'Delivery health', value: health, inline: false },
          { name: 'Latest report', value: latest, inline: false },
        ],
      },
    ],
    flags: ephemeral ? MessageFlags.EPHEMERAL : undefined,
    allowed_mentions: { parse: [] },
  };
}

export function ephemeral(content: string): { type: 4; data: MessageBody } {
  return { type: 4, data: { content, flags: MessageFlags.EPHEMERAL, allowed_mentions: { parse: [] } } };
}

export function mirrorForReport(r: Report, guildName: string): MirrorMessage {
  return {
    title: `${SEVERITY_EMOJI[r.severity]} New ${r.severity} report #${r.id} in ${guildName}`,
    body: r.summary ?? clip(r.text, 500),
    fields: [
      { name: 'Category', value: r.category },
      { name: 'Reporter', value: r.userName ?? 'unknown' },
      ...(r.tags.length ? [{ name: 'Tags', value: r.tags.join(', ') }] : []),
    ],
    color: SEVERITY_COLOR[r.severity],
    footer: `Original: "${clip(r.text.replace(/\s+/g, ' '), 200)}"`,
  };
}

export function mirrorForStatusChange(r: Report, guildName: string): MirrorMessage {
  return {
    title: `${STATUS_LABEL[r.status]} · report #${r.id} in ${guildName}`,
    body: r.summary ?? clip(r.text, 300),
    fields: [
      { name: 'Changed by', value: r.statusBy ?? 'unknown' },
      { name: 'Severity', value: r.severity },
    ],
    color: r.status === 'resolved' ? 0x3ba55d : SEVERITY_COLOR[r.severity],
    footer: `Report #${r.id}`,
  };
}

import { config } from '../config.js';
import { CATEGORIES, SEVERITIES, type GuildConfig, type Report } from '../domain.js';
import type { DiscordChannel, DiscordRole } from '../discord/api.js';
import { html, SafeHtml } from '../lib/html.js';
import { ACTION_TYPES, CONDITION_TYPES, describeRule } from '../services/rules.js';
import type { GuildSummary } from '../services/guilds.js';
import type { SessionInfo } from './auth.js';

export interface Flash {
  ok?: string;
  err?: string;
}

const csrfField = (s: SessionInfo) => html`<input type="hidden" name="_csrf" value="${s.csrf}">`;

function time(d: Date | string | null | undefined): SafeHtml {
  if (!d) return html`<span class="muted">—</span>`;
  const iso = new Date(d).toISOString();
  return html`<time datetime="${iso}" title="${iso}">${iso.replace('T', ' ').slice(0, 19)} UTC</time>`;
}

function guildIcon(g: Pick<GuildConfig, 'id' | 'icon' | 'name'>, size = 40): SafeHtml {
  return g.icon
    ? html`<img class="gicon" width="${size}" height="${size}" alt="" src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64">`
    : html`<span class="gicon gicon-fallback" style="width:${size}px;height:${size}px">${g.name.slice(0, 1).toUpperCase()}</span>`;
}

export function badge(text: string, tone: 'ok' | 'warn' | 'err' | 'info' | 'muted' | string = 'muted'): SafeHtml {
  return html`<span class="badge badge-${tone}">${text}</span>`;
}

const SEVERITY_TONE: Record<string, string> = { low: 'ok', medium: 'info', high: 'warn', critical: 'err' };
const STATUS_TONE: Record<string, string> = { open: 'warn', acknowledged: 'info', resolved: 'ok' };

function flashBox(flash?: Flash): SafeHtml {
  return html`${flash?.ok ? html`<div class="flash flash-ok" role="status">${flash.ok}</div>` : ''}${
    flash?.err ? html`<div class="flash flash-err" role="alert">${flash.err}</div>` : ''
  }`;
}

export function layout(opts: { title: string; session?: SessionInfo; body: SafeHtml; flash?: Flash }): SafeHtml {
  const s = opts.session;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Report Bot</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/dashboard"><span class="logo" aria-hidden="true">◆</span> Report Bot</a>
  ${
    s
      ? html`<nav class="topnav">
    <span class="muted who">${s.email}</span>
    <form method="post" action="/logout">${csrfField(s)}<button class="btn btn-ghost" type="submit">Sign out</button></form>
  </nav>`
      : ''
  }
</header>
<main class="container">
${flashBox(opts.flash)}
${opts.body}
</main>
</body>
</html>`;
}

export function authPage(opts: { mode: 'login' | 'signup'; next: string; allowSignup: boolean; error?: string; email?: string }): SafeHtml {
  const login = opts.mode === 'login';
  return layout({
    title: login ? 'Sign in' : 'Create account',
    flash: opts.error ? { err: opts.error } : undefined,
    body: html`<section class="auth card">
  <h1>${login ? 'Admin sign in' : 'Create an admin account'}</h1>
  <p class="muted">Manage the Discord bot, review the live command log and configure rules.</p>
  <form method="post" action="${login ? '/login' : '/signup'}" class="stack">
    <input type="hidden" name="next" value="${opts.next}">
    <label>Email <input type="email" name="email" required autocomplete="username" value="${opts.email ?? ''}"></label>
    <label>Password <input type="password" name="password" required minlength="8" autocomplete="${login ? 'current-password' : 'new-password'}"></label>
    <button class="btn btn-primary" type="submit">${login ? 'Sign in' : 'Create account'}</button>
  </form>
  ${
    opts.allowSignup
      ? html`<p class="muted small">${login ? html`No account? <a href="/signup">Create one</a>` : html`Have an account? <a href="/login">Sign in</a>`}</p>`
      : ''
  }
</section>`,
  });
}

// ---------------- overview ----------------

export function overviewPage(opts: {
  session: SessionInfo;
  guilds: GuildSummary[];
  security: { total: number; byReason: Record<string, number>; recent: Array<{ at: string; reason: string; ip: string }>; since: Date };
  spoolSize: number;
  aiConfigured: boolean;
  flash?: Flash;
}): SafeHtml {
  const { guilds } = opts;
  return layout({
    title: 'Servers',
    session: opts.session,
    flash: opts.flash,
    body: html`
<div class="page-head">
  <div><h1>Your Discord servers</h1><p class="muted">Each connected server has its own channel, mirror, rules and log.</p></div>
  <a class="btn btn-primary" href="/connect/discord">+ Connect a Discord server</a>
</div>

${
  guilds.length
    ? html`<div class="grid">${guilds.map(
        (g) => html`<a class="card guild-card" href="/dashboard/g/${g.id}">
  <div class="row">${guildIcon(g)}<div><strong>${g.name}</strong><div class="muted small">ID ${g.id}</div></div></div>
  <div class="chips">
    ${g.reportChannelId ? badge(`#${g.reportChannelName ?? 'channel'}`, 'ok') : badge('no report channel', 'warn')}
    ${g.mirrorKind ? badge(`mirror: ${g.mirrorKind}`, 'ok') : badge('no mirror', 'warn')}
    ${g.deadJobs ? badge(`${g.deadJobs} failed`, 'err') : ''}
  </div>
  <div class="stats-inline"><span><b>${g.reportsOpen}</b> open reports</span><span><b>${g.interactions24h}</b> commands / 24h</span></div>
</a>`,
      )}</div>`
    : html`<section class="card empty">
  <h2>Connect your first server</h2>
  <ol class="steps">
    <li>Click <b>Connect a Discord server</b>. Discord asks which server to add the bot to (you need <i>Manage Server</i> there).</li>
    <li>You come back here; slash commands <code>/report</code> and <code>/status</code> are registered automatically.</li>
    <li>Pick a report channel and paste a Slack or Discord webhook for mirroring.</li>
  </ol>
  <a class="btn btn-primary" href="/connect/discord">Connect a Discord server</a>
</section>`
}

<div class="grid grid-2">
  <section class="card">
    <h2>System</h2>
    <dl class="kv">
      <dt>Interactions endpoint</dt><dd><code>${config.baseUrl}/interactions</code></dd>
      <dt>AI triage</dt><dd>${opts.aiConfigured ? badge('Groq configured', 'ok') : badge('no GROQ_API_KEY – keyword triage', 'warn')}</dd>
      <dt>Spooled interactions</dt><dd>${opts.spoolSize ? badge(`${opts.spoolSize} waiting for database`, 'warn') : badge('0', 'ok')}</dd>
    </dl>
  </section>
  <section class="card">
    <h2>Rejected requests <span class="muted small">since ${time(opts.security.since)}</span></h2>
    <p class="muted small">Unsigned, forged, stale (replayed) or malformed calls to the interactions endpoint. Answered with 401/400, never processed.</p>
    ${
      opts.security.total
        ? html`<div class="chips">${Object.entries(opts.security.byReason).map(([k, v]) => badge(`${k}: ${v}`, 'err'))}</div>
    <table class="table small"><thead><tr><th>When</th><th>Reason</th><th>Source</th></tr></thead><tbody>
    ${opts.security.recent.slice(0, 8).map((r) => html`<tr><td>${time(r.at)}</td><td>${r.reason}</td><td>${r.ip}</td></tr>`)}
    </tbody></table>`
        : html`<p>${badge('none', 'ok')}</p>`
    }
  </section>
</div>`,
  });
}

// ---------------- guild shell ----------------

type Tab = 'activity' | 'reports' | 'rules' | 'settings' | 'failures';

export function guildLayout(opts: { session: SessionInfo; cfg: GuildConfig; tab: Tab; body: SafeHtml; flash?: Flash; failures?: number }): SafeHtml {
  const { cfg } = opts;
  const tabs: Array<[Tab, string]> = [
    ['activity', 'Live log'],
    ['reports', 'Reports'],
    ['rules', 'Rules'],
    ['settings', 'Settings'],
    ['failures', opts.failures ? `Failures (${opts.failures})` : 'Failures'],
  ];
  const setupMissing = !cfg.reportChannelId || !cfg.mirrorKind || !cfg.commandsSyncedAt;
  return layout({
    title: cfg.name,
    session: opts.session,
    flash: opts.flash,
    body: html`
<a class="muted small back" href="/dashboard">← All servers</a>
<div class="page-head">
  <div class="row">${guildIcon(cfg, 48)}<div><h1>${cfg.name}</h1><div class="muted small">Server ID ${cfg.id}</div></div></div>
</div>
${
  setupMissing
    ? html`<div class="flash flash-warn">Finish setup:
  ${!cfg.commandsSyncedAt ? html`<a href="/dashboard/g/${cfg.id}/settings">register slash commands</a> · ` : ''}
  ${!cfg.reportChannelId ? html`<a href="/dashboard/g/${cfg.id}/settings">pick a report channel</a> · ` : ''}
  ${!cfg.mirrorKind ? html`<a href="/dashboard/g/${cfg.id}/settings">add a mirror webhook</a>` : ''}
</div>`
    : ''
}
<nav class="tabs" aria-label="Server sections">
  ${tabs.map(([t, label]) => html`<a href="/dashboard/g/${cfg.id}${t === 'activity' ? '' : `/${t}`}" class="${t === opts.tab ? 'active' : ''}">${label}</a>`)}
</nav>
${opts.body}`,
  });
}

export function activityBody(cfg: GuildConfig): SafeHtml {
  return html`
<section class="card" id="activity" data-guild="${cfg.id}">
  <div class="card-head">
    <h2>Commands &amp; actions <span id="live" class="live" title="Live updates">● live</span></h2>
    <span class="muted small">Every interaction, what it triggered, and whether each action was delivered.</span>
  </div>
  <div class="table-wrap">
  <table class="table" id="activity-table">
    <thead><tr><th>When</th><th>User</th><th>Command</th><th>Input</th><th>Reply</th><th>Actions</th><th>Outcome</th></tr></thead>
    <tbody><tr><td colspan="7" class="muted">Loading…</td></tr></tbody>
  </table>
  </div>
</section>
<section class="card">
  <div class="card-head"><h2>Event stream</h2><span class="muted small">Structured events: triage, rule matches, deliveries, retries, failures.</span></div>
  <ul class="events" id="events-list"><li class="muted">Loading…</li></ul>
</section>`;
}

export function reportsBody(reports: Report[]): SafeHtml {
  if (!reports.length) return html`<section class="card empty"><p>No reports yet. Run <code>/report</code> in your server.</p></section>`;
  return html`<section class="card"><div class="table-wrap"><table class="table">
<thead><tr><th>#</th><th>When</th><th>Reporter</th><th>Severity</th><th>Category</th><th>Summary / text</th><th>Triage</th><th>Status</th></tr></thead>
<tbody>
${reports.map(
  (r) => html`<tr>
  <td>${r.id}</td>
  <td class="nowrap">${time(r.createdAt)}</td>
  <td>${r.userName ?? '—'}</td>
  <td>${badge(r.severity, SEVERITY_TONE[r.severity])}</td>
  <td>${r.category}</td>
  <td><div>${r.summary ?? ''}</div><div class="muted small clamp">${r.text}</div>${
    r.tags.length ? html`<div class="chips">${r.tags.map((t) => badge(t, 'muted'))}</div>` : ''
  }${r.matchedRules.length ? html`<div class="muted small">Rules: ${r.matchedRules.map((m) => m.description).join('; ')}</div>` : ''}</td>
  <td>${badge(r.aiStatus, r.aiStatus === 'ok' ? 'ok' : r.aiStatus === 'fallback' ? 'warn' : 'muted')}</td>
  <td>${badge(r.status, STATUS_TONE[r.status])}${r.statusBy ? html`<div class="muted small">by ${r.statusBy}</div>` : ''}</td>
</tr>`,
)}
</tbody></table></div></section>`;
}

function select(name: string, options: Array<[string, string]>, selected?: string | null, attrs = ''): SafeHtml {
  return html`<select name="${name}" ${new SafeHtml(attrs)}>${options.map(
    ([v, label]) => html`<option value="${v}" ${v === (selected ?? '') ? new SafeHtml('selected') : ''}>${label}</option>`,
  )}</select>`;
}

export function rulesBody(opts: { session: SessionInfo; cfg: GuildConfig; roles: DiscordRole[] }): SafeHtml {
  const { cfg, session } = opts;
  const base = `/dashboard/g/${cfg.id}/rules`;
  return html`
<section class="card">
  <div class="card-head"><h2>Rules for <code>/report</code></h2>
  <span class="muted small">Evaluated top to bottom after triage. Severity rules run first; the rest see the final severity.</span></div>
  ${
    cfg.rules.length
      ? html`<div class="table-wrap"><table class="table">
  <thead><tr><th>Order</th><th>Rule</th><th>Enabled</th><th></th></tr></thead>
  <tbody>
  ${cfg.rules.map(
    (r, idx) => html`<tr class="${r.enabled ? '' : 'disabled'}">
    <td class="nowrap">
      <form method="post" action="${base}/${r.id}/move" class="inline">${csrfField(session)}<input type="hidden" name="direction" value="up"><button class="btn btn-ghost btn-sm" ${idx === 0 ? new SafeHtml('disabled') : ''} aria-label="Move up">↑</button></form>
      <form method="post" action="${base}/${r.id}/move" class="inline">${csrfField(session)}<input type="hidden" name="direction" value="down"><button class="btn btn-ghost btn-sm" ${idx === cfg.rules.length - 1 ? new SafeHtml('disabled') : ''} aria-label="Move down">↓</button></form>
    </td>
    <td>${describeRule(r)}</td>
    <td><form method="post" action="${base}/${r.id}/toggle" class="inline">${csrfField(session)}<button class="btn btn-sm ${r.enabled ? 'btn-ok' : 'btn-ghost'}">${r.enabled ? 'On' : 'Off'}</button></form></td>
    <td><form method="post" action="${base}/${r.id}/delete" class="inline" data-confirm="Delete this rule?">${csrfField(session)}<button class="btn btn-sm btn-danger">Delete</button></form></td>
  </tr>`,
  )}
  </tbody></table></div>`
      : html`<p class="muted">No rules — reports are recorded and replied to, but never mirrored or escalated.</p>`
  }
</section>

<section class="card">
  <h2>Add a rule</h2>
  <form method="post" action="${base}" class="rule-form" id="rule-form">
    ${csrfField(session)}
    <label>When
      ${select('conditionType', Object.entries(CONDITION_TYPES) as Array<[string, string]>, 'keyword', 'data-cond')}
    </label>
    <label class="cond-value">Value
      <input name="conditionValue" placeholder="e.g. refund, payment" data-for="keyword">
      ${select('conditionValue', SEVERITIES.map((s) => [s, s]), 'high', 'data-for="severity_gte" disabled')}
      ${select('conditionValue', CATEGORIES.map((c) => [c, c]), 'bug', 'data-for="category_is" disabled')}
    </label>
    <label>Then
      ${select('actionType', Object.entries(ACTION_TYPES) as Array<[string, string]>, 'set_severity', 'data-act')}
    </label>
    <label class="act-value">Value
      ${select('actionValue', SEVERITIES.map((s) => [s, s]), 'high', 'data-for="set_severity"')}
      ${select('actionValue', [['', 'Server alert role (from Settings)'], ...opts.roles.map((r) => [r.id, `@${r.name}`] as [string, string])], '', 'data-for="mention_role" disabled')}
      <input name="actionValue" placeholder="Text shown to the reporter" data-for="reply_note" disabled>
    </label>
    <button class="btn btn-primary" type="submit">Add rule</button>
  </form>
</section>`;
}

export function settingsBody(opts: {
  session: SessionInfo;
  cfg: GuildConfig;
  channels: DiscordChannel[];
  roles: DiscordRole[];
  discordError?: string;
}): SafeHtml {
  const { cfg, session } = opts;
  const s = cfg.settings;
  const base = `/dashboard/g/${cfg.id}/settings`;
  const checkbox = (name: string, checked: boolean, label: string) =>
    html`<label class="check"><input type="checkbox" name="${name}" value="1" ${checked ? new SafeHtml('checked') : ''}> ${label}</label>`;
  return html`
${opts.discordError ? html`<div class="flash flash-err">Couldn't load channels/roles from Discord: ${opts.discordError}</div>` : ''}
<div class="grid grid-2">
<section class="card">
  <h2>Report channel</h2>
  <p class="muted small">Where the bot posts each report card (with Acknowledge / Resolve buttons). The bot needs View Channel, Send Messages and Embed Links there.</p>
  <form method="post" action="${base}/channel" class="stack">
    ${csrfField(session)}
    ${select('channelId', [['', '— none (buttons go on the reply) —'], ...opts.channels.map((c) => [c.id, `#${c.name}`] as [string, string])], cfg.reportChannelId)}
    <label>Alert role (for “Mention role” rules)
      ${select('alertRoleId', [['', '— none —'], ...opts.roles.map((r) => [r.id, `@${r.name}`] as [string, string])], cfg.alertRoleId)}
    </label>
    <button class="btn btn-primary">Save</button>
  </form>
</section>

<section class="card">
  <h2>Mirror channel</h2>
  <p class="muted small">A Slack Incoming Webhook or a Discord channel webhook. Stored encrypted; never shown again after saving.</p>
  <p>Current: ${cfg.mirrorHint ? badge(cfg.mirrorHint, 'ok') : badge('not configured', 'warn')}</p>
  <form method="post" action="${base}/mirror" class="stack">
    ${csrfField(session)}
    <input type="url" name="webhookUrl" placeholder="https://hooks.slack.com/services/…  or  https://discord.com/api/webhooks/…" autocomplete="off" required>
    <button class="btn btn-primary">Save webhook</button>
  </form>
  ${
    cfg.mirrorKind
      ? html`<div class="row gap">
    <form method="post" action="${base}/mirror/test" class="inline">${csrfField(session)}<button class="btn">Send test message</button></form>
    <form method="post" action="${base}/mirror/remove" class="inline" data-confirm="Remove the mirror webhook?">${csrfField(session)}<button class="btn btn-danger">Remove</button></form>
  </div>`
      : ''
  }
</section>

<section class="card">
  <h2>Command behaviour</h2>
  <form method="post" action="${base}/commands" class="stack">
    ${csrfField(session)}
    <fieldset><legend><code>/report</code></legend>
      ${checkbox('reportEnabled', s.commands.report.enabled, 'Enabled')}
      ${checkbox('reportEphemeral', s.commands.report.ephemeral, 'Reply only visible to the reporter')}
      <label>Cooldown per user (seconds) <input type="number" name="reportCooldown" min="0" max="3600" value="${s.commands.report.cooldownSeconds}"></label>
    </fieldset>
    <fieldset><legend><code>/status</code></legend>
      ${checkbox('statusEnabled', s.commands.status.enabled, 'Enabled')}
      ${checkbox('statusEphemeral', s.commands.status.ephemeral, 'Reply only visible to the caller')}
    </fieldset>
    <fieldset><legend>Triage &amp; buttons</legend>
      ${checkbox('aiEnabled', s.aiEnabled, `AI triage with Groq${config.GROQ_API_KEY ? '' : ' (no API key set — keyword triage will be used)'}`)}
      ${checkbox('resolveRequiresManageMessages', s.resolveRequiresManageMessages, 'Only moderators (Manage Messages) can Resolve / Reopen')}
    </fieldset>
    <fieldset><legend>Fault injection (for testing retries)</legend>
      <label>Fail the next N mirror deliveries <input type="number" name="simulateMirrorFailures" min="0" max="20" value="${s.simulateMirrorFailures}"></label>
      <p class="muted small">Each failed attempt is retried with exponential backoff; watch it in the Live log and Failures tabs.</p>
    </fieldset>
    <button class="btn btn-primary">Save behaviour</button>
  </form>
</section>

<section class="card">
  <h2>Slash commands</h2>
  <p class="muted small">Registers <code>/report</code> and <code>/status</code> in this server (instant; no global propagation delay).</p>
  <p>Last synced: ${cfg.commandsSyncedAt ? time(cfg.commandsSyncedAt) : badge('never', 'warn')}</p>
  <form method="post" action="${base}/sync-commands">${csrfField(session)}<button class="btn">Register / re-sync commands</button></form>
  <hr>
  <h2>Disconnect</h2>
  <p class="muted small">The bot leaves the server and this server's data (reports, log, rules) is deleted.</p>
  <form method="post" action="${base}/disconnect" data-confirm="Remove the bot from ${cfg.name} and delete its data?">${csrfField(session)}<button class="btn btn-danger">Disconnect server</button></form>
</section>
</div>`;
}

export interface FailureRow {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_at: Date;
  updated_at: Date;
  interaction_id: string | null;
}

export function failuresBody(opts: {
  session: SessionInfo;
  cfg: GuildConfig;
  jobs: FailureRow[];
  events: Array<{ created_at: Date; level: string; kind: string; message: string }>;
}): SafeHtml {
  const { cfg, session } = opts;
  return html`
<section class="card">
  <div class="card-head"><h2>Failed &amp; retrying actions</h2>
  <span class="muted small">Retryable failures back off exponentially (2s → 5 min). Permanent failures or exhausted retries land here as <b>dead</b>.</span></div>
  ${
    opts.jobs.length
      ? html`<div class="table-wrap"><table class="table">
  <thead><tr><th>Action</th><th>State</th><th>Attempts</th><th>Last error</th><th>Next / last try</th><th></th></tr></thead>
  <tbody>${opts.jobs.map(
    (j) => html`<tr>
    <td><code>${j.kind}</code>${j.interaction_id ? html`<div class="small"><a href="/dashboard/g/${cfg.id}/i/${j.interaction_id}">interaction</a></div>` : ''}</td>
    <td>${badge(j.status === 'dead' ? 'dead' : 'retrying', j.status === 'dead' ? 'err' : 'warn')}</td>
    <td>${j.attempts}/${j.max_attempts}</td>
    <td class="small err-text">${j.last_error ?? ''}</td>
    <td class="nowrap">${time(j.status === 'dead' ? j.updated_at : j.run_at)}</td>
    <td><form method="post" action="/dashboard/g/${cfg.id}/jobs/${j.id}/retry">${csrfField(session)}<button class="btn btn-sm">Retry now</button></form></td>
  </tr>`,
  )}</tbody></table></div>`
      : html`<p>${badge('No failed or retrying actions', 'ok')}</p>`
  }
</section>
<section class="card">
  <h2>Recent warnings &amp; errors</h2>
  ${
    opts.events.length
      ? html`<ul class="events">${opts.events.map(
          (e) => html`<li class="ev ev-${e.level}"><span class="ev-time">${time(e.created_at)}</span> ${badge(e.kind, e.level === 'error' ? 'err' : 'warn')} ${e.message}</li>`,
        )}</ul>`
      : html`<p class="muted">Nothing to report.</p>`
  }
</section>`;
}

export function interactionDetailBody(opts: {
  cfg: GuildConfig;
  interaction: { id: string; command: string | null; user_name: string | null; input: string | null; outcome: string; received_at: Date; response_type: number | null; response_ms: number | null; spooled: boolean };
  jobs: FailureRow[];
  events: Array<{ created_at: Date; level: string; kind: string; message: string }>;
  report: Report | null;
}): SafeHtml {
  const i = opts.interaction;
  return html`
<section class="card">
  <h2>Interaction <code>${i.id}</code></h2>
  <dl class="kv">
    <dt>Command</dt><dd><code>${i.command ?? '—'}</code></dd>
    <dt>User</dt><dd>${i.user_name ?? '—'}</dd>
    <dt>Input</dt><dd>${i.input ?? '—'}</dd>
    <dt>Received</dt><dd>${time(i.received_at)}${i.spooled ? html` ${badge('recovered from spool', 'warn')}` : ''}</dd>
    <dt>Initial response</dt><dd>${i.response_type ?? '—'} ${i.response_ms !== null ? html`<span class="muted">in ${i.response_ms} ms</span>` : ''}</dd>
    <dt>Outcome</dt><dd>${badge(i.outcome, i.outcome === 'completed' ? 'ok' : i.outcome === 'failed' ? 'err' : 'warn')}</dd>
    ${opts.report ? html`<dt>Report</dt><dd>#${opts.report.id} · ${badge(opts.report.severity, SEVERITY_TONE[opts.report.severity])} · ${opts.report.summary ?? ''}</dd>` : ''}
  </dl>
</section>
<section class="card">
  <h2>Actions</h2>
  ${
    opts.jobs.length
      ? html`<table class="table"><thead><tr><th>Action</th><th>State</th><th>Attempts</th><th>Last error</th></tr></thead><tbody>${opts.jobs.map(
          (j) => html`<tr><td><code>${j.kind}</code></td><td>${badge(j.status, j.status === 'succeeded' ? 'ok' : j.status === 'dead' ? 'err' : 'warn')}</td><td>${j.attempts}/${j.max_attempts}</td><td class="small err-text">${j.last_error ?? ''}</td></tr>`,
        )}</tbody></table>`
      : html`<p class="muted">Answered inline; no follow-up actions.</p>`
  }
</section>
<section class="card">
  <h2>Timeline</h2>
  <ul class="events">${opts.events.map(
    (e) => html`<li class="ev ev-${e.level}"><span class="ev-time">${time(e.created_at)}</span> ${badge(e.kind, e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : 'info')} ${e.message}</li>`,
  )}</ul>
</section>`;
}

export function errorPage(status: number, message: string, session?: SessionInfo): string {
  return layout({ title: `Error ${status}`, session, body: html`<section class="card empty"><h1>${status}</h1><p>${message}</p><a href="/dashboard">Back to dashboard</a></section>` }).value;
}

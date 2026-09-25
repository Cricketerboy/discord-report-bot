// End-to-end: real app process + real Postgres (PGlite) + mock Discord / Slack / Groq.
// Exercises the happy path and every "unhappy path" from the quality bar.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN,
  Browser,
  CHANNEL_ID,
  GUILD,
  interaction,
  MockUpstreams,
  postSigned,
  ROLE_ID,
  slash,
  TestApp,
  TestDatabase,
  waitFor,
} from './harness.js';

const db = new TestDatabase();
const up = new MockUpstreams();
let app: TestApp;
let browser: Browser;

async function activity(): Promise<any[]> {
  const res = await browser.fetch(`/api/g/${GUILD.id}/activity`);
  assert.equal(res.status, 200);
  return (await res.json()).items;
}

async function itemFor(id: string) {
  return (await activity()).find((i) => i.id === id);
}

describe('discord report bot (e2e)', { timeout: 180_000 }, () => {
  before(async () => {
    await db.start();
    await up.start();
    app = new TestApp(db.url, up.port);
    try {
      await app.start();
    } catch (err) {
      console.error(app.logs);
      throw err;
    }
    browser = new Browser(app.url);
  });

  after(async () => {
    await app?.stop();
    await up.stop();
    await db.stop();
  });

  it('dashboard requires login', async () => {
    const res = await fetch(`${app.url}/dashboard`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/login/);
    assert.equal((await fetch(`${app.url}/api/g/${GUILD.id}/activity`)).status, 401);
  });

  it('rejects a wrong password and accepts the seeded admin', async () => {
    const bad = await browser.form('/login', { email: ADMIN.email, password: 'nope', next: '/dashboard' });
    assert.equal(bad.status, 401);
    const ok = await browser.form('/login', { email: ADMIN.email, password: ADMIN.password, next: '/dashboard' });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/dashboard');
    assert.equal((await browser.fetch('/dashboard')).status, 200);
  });

  it('connects a guild through the OAuth install flow and registers commands', async () => {
    const start = await browser.fetch('/connect/discord');
    const location = new URL(start.headers.get('location')!);
    assert.equal(location.hostname, 'discord.com');
    assert.match(location.searchParams.get('scope')!, /applications\.commands/);
    const state = location.searchParams.get('state')!;

    const forged = await browser.fetch(`/connect/discord/callback?code=abc&state=not-the-state`);
    assert.match(forged.headers.get('location')!, /err=/);

    // state is single-use, so start again
    const again = new URL((await browser.fetch('/connect/discord')).headers.get('location')!);
    const cb = await browser.fetch(`/connect/discord/callback?code=abc&state=${again.searchParams.get('state')}`);
    assert.match(cb.headers.get('location')!, new RegExp(`/dashboard/g/${GUILD.id}/settings`));
    assert.notEqual(state, again.searchParams.get('state'));
    assert.ok(up.commandRegistrations >= 1);
  });

  it('configures report channel, alert role and the mirror webhook (with CSRF)', async () => {
    const path = `/dashboard/g/${GUILD.id}/settings`;
    const noCsrf = await browser.form(`${path}/channel`, { channelId: CHANNEL_ID });
    assert.equal(noCsrf.status, 403);

    const csrf = await browser.csrf(path);
    assert.equal((await browser.form(`${path}/channel`, { _csrf: csrf, channelId: CHANNEL_ID, alertRoleId: ROLE_ID })).status, 302);
    const bad = await browser.form(`${path}/mirror`, { _csrf: csrf, webhookUrl: 'ftp://nope' });
    assert.match(bad.headers.get('location')!, /err=/);
    const good = await browser.form(`${path}/mirror`, { _csrf: csrf, webhookUrl: `http://127.0.0.1:${up.port}/services/slack-mirror` });
    assert.match(good.headers.get('location')!, /ok=/);

    const page = await (await browser.fetch(path)).text();
    assert.ok(!page.includes('/services/slack-mirror'), 'webhook URL must never be rendered back');
  });

  it('rejects unsigned, forged and replayed requests with 401', async () => {
    const ping = interaction(1, undefined);
    const unsigned = await fetch(`${app.url}/interactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ping) });
    assert.equal(unsigned.status, 401);

    const attacker = generateKeyPairSync('ed25519');
    assert.equal((await postSigned(app.url, ping, { key: attacker.privateKey })).status, 401);

    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await postSigned(app.url, ping, { timestamp: stale })).status, 401);
  });

  it('answers PING with PONG', async () => {
    const res = await postSigned(app.url, interaction(1, undefined));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { type: 1 });
  });

  let firstReport: ReturnType<typeof slash>;

  it('/report: defers, triages with AI, applies rules, replies, posts to channel and mirrors', async () => {
    firstReport = slash('report', 'URGENT: checkout is broken for everyone');
    const res = await postSigned(app.url, firstReport);
    assert.equal(res.status, 200);
    assert.equal(res.json.type, 5, 'must defer (type 5) and do slow work async');
    assert.equal(res.json.data.flags, 64);

    await waitFor(() => up.edits.find((e) => e.token === firstReport.token), 'reply edit');
    const post = await waitFor(() => up.channelPosts.find((p) => p.body.nonce === firstReport.id), 'channel post');
    await waitFor(() => up.mirror.length === 1, 'mirror');

    // keyword rule "urgent" escalated AI's "high" to critical, which then pinged the alert role
    assert.equal(post.channelId, CHANNEL_ID);
    assert.equal(post.body.embeds[0].title, 'Report #1');
    assert.match(post.body.content, new RegExp(`<@&${ROLE_ID}>`));
    assert.deepEqual(post.body.allowed_mentions, { parse: [], roles: [ROLE_ID] });
    assert.equal(post.body.components[0].components.length, 2);

    const item = await waitFor(async () => {
      const i = await itemFor(firstReport.id);
      return i?.outcome === 'completed' ? i : null;
    }, 'interaction completed');
    assert.equal(item.report.severity, 'critical');
    assert.equal(item.report.ai_status, 'ok');
    assert.equal(item.report.summary, 'Checkout page fails for all users');
    assert.deepEqual(item.jobs.map((j: any) => j.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    assert.equal(item.responseType, 5);
    assert.ok(item.responseMs < 2500, `answered in ${item.responseMs}ms`);
  });

  it('ignores a duplicate delivery of the same interaction', async () => {
    const edits = up.edits.length;
    const res = await postSigned(app.url, firstReport);
    assert.equal(res.json.type, 4);
    assert.match(res.json.data.content, /already received/);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(up.mirror.length, 1, 'mirror must not fire twice');
    assert.equal(up.channelPosts.length, 1);
    assert.equal(up.edits.length, edits);
  });

  it('/status answers inline with live numbers', async () => {
    const res = await postSigned(app.url, slash('status'));
    assert.equal(res.json.type, 4);
    const fields = res.json.data.embeds[0].fields;
    assert.equal(fields.find((f: any) => f.name === 'Open').value, '1');
  });

  it('/report without text opens a modal, and the modal submission is processed', async () => {
    const open = await postSigned(app.url, slash('report', undefined, { userId: '700000000000000099' }));
    assert.equal(open.json.type, 9);
    assert.equal(open.json.data.custom_id, 'report_modal');

    const submit = interaction(
      5,
      { custom_id: 'report_modal', components: [{ type: 1, components: [{ type: 4, custom_id: 'report_text', value: 'Love the new theme, maybe add dark mode?' }] }] },
      { userId: '700000000000000099' },
    );
    const res = await postSigned(app.url, submit);
    assert.equal(res.json.type, 5);
    const item = await waitFor(async () => {
      const i = await itemFor(submit.id);
      return i?.outcome === 'completed' ? i : null;
    }, 'modal report processed');
    assert.equal(item.command, 'report (form)');
    assert.equal(item.report.category, 'feedback');
  });

  it('enforces the per-user cooldown rule', async () => {
    const res = await postSigned(app.url, slash('report', 'another one right away', { userId: '700000000000000099' }));
    assert.equal(res.json.type, 4);
    assert.match(res.json.data.content, /too quickly/);
  });

  it('buttons: acknowledge updates the message; resolve needs Manage Messages; a repeat click is a no-op', async () => {
    const message = { id: up.channelPosts[0]!.id, channel_id: CHANNEL_ID };
    const ack = interaction(3, { custom_id: 'report:ack:1', component_type: 2 }, { message });
    const ackRes = await postSigned(app.url, ack);
    assert.equal(ackRes.json.type, 7);
    assert.match(JSON.stringify(ackRes.json.data.embeds), /Acknowledged by Alice/);
    await waitFor(() => up.mirror.length === 3, 'status-change mirror'); // 1 report + 1 modal report + 1 ack

    const denied = await postSigned(app.url, interaction(3, { custom_id: 'report:resolve:1', component_type: 2 }, { message }));
    assert.equal(denied.json.type, 4);
    assert.match(denied.json.data.content, /Manage Messages/);

    const MANAGE_MESSAGES = String(1n << 13n);
    const resolve = await postSigned(app.url, interaction(3, { custom_id: 'report:resolve:1', component_type: 2 }, { message, permissions: MANAGE_MESSAGES }));
    assert.equal(resolve.json.type, 7);
    assert.equal(resolve.json.data.components[0].components[0].label, 'Reopen');
    await waitFor(() => up.mirror.length === 4, 'resolve mirror');

    const again = await postSigned(app.url, interaction(3, { custom_id: 'report:resolve:1', component_type: 2 }, { message, permissions: MANAGE_MESSAGES }));
    assert.equal(again.json.type, 7);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(up.mirror.length, 4, 'resolving an already-resolved report must not notify again');
  });

  it('retries a failing mirror with backoff until it succeeds', async () => {
    up.failMirror = 2;
    const r = slash('report', 'small typo on the pricing page', { userId: '700000000000000011' });
    assert.equal((await postSigned(app.url, r)).json.type, 5);
    const item = await waitFor(
      async () => {
        const i = await itemFor(r.id);
        return i?.outcome === 'completed' ? i : null;
      },
      'mirror retried to success',
      30_000,
    );
    const mirrorJob = item.jobs.find((j: any) => j.kind === 'mirror.send');
    assert.equal(mirrorJob.status, 'succeeded');
    assert.equal(mirrorJob.attempts, 3);
    assert.equal(up.failMirror, 0);
  });

  it('falls back to keyword triage when the AI is down (and still replies)', async () => {
    up.failAi = 10;
    const r = slash('report', 'the app keeps crashing with an error', { userId: '700000000000000012' });
    await postSigned(app.url, r);
    const item = await waitFor(async () => {
      const i = await itemFor(r.id);
      return i?.outcome === 'completed' ? i : null;
    }, 'fallback triage');
    assert.equal(item.report.ai_status, 'fallback');
    assert.equal(item.report.severity, 'high');
    assert.ok(up.edits.find((e) => e.token === r.token), 'reporter still got a reply');
    up.failAi = 0;
  });

  it('does not lose an interaction while the database is down (spool → replay)', async () => {
    await db.goDown();
    const r = slash('report', 'database outage test report', { userId: '700000000000000013' });
    const started = Date.now();
    const res = await postSigned(app.url, r);
    assert.equal(res.json.type, 5, 'still acknowledges Discord in time');
    assert.ok(Date.now() - started < 3000, 'within the 3 second window');

    await new Promise((resolve) => setTimeout(resolve, 1500));
    await db.listen();

    await waitFor(() => up.edits.find((e) => e.token === r.token), 'reply after DB recovery', 45_000);
    const item = await waitFor(async () => {
      const i = await itemFor(r.id);
      return i?.outcome === 'completed' ? i : null;
    }, 'spooled interaction completed', 30_000);
    assert.equal(item.spooled, true);
  });

  it('survives a restart and still dedups against the database', async () => {
    const mirrors = up.mirror.length;
    await app.stop();
    await app.start();
    const res = await postSigned(app.url, firstReport);
    assert.equal(res.json.type, 4);
    assert.match(res.json.data.content, /already received/);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(up.mirror.length, mirrors);
  });

  it('renders every dashboard page, and rule CRUD works', async () => {
    const g = `/dashboard/g/${GUILD.id}`;
    for (const path of ['/dashboard', g, `${g}/reports`, `${g}/rules`, `${g}/settings`, `${g}/failures`, `${g}/i/${firstReport.id}`]) {
      const res = await browser.fetch(path);
      assert.equal(res.status, 200, path);
      const body = await res.text();
      assert.ok(!body.includes('[object Object]'), `${path} rendered an object`);
    }
    const reports = await (await browser.fetch(`${g}/reports`)).text();
    assert.ok(reports.includes('Checkout page fails for all users'));

    const csrf = await browser.csrf(`${g}/rules`);
    const add = await browser.form(`${g}/rules`, { _csrf: csrf, conditionType: 'category_is', conditionValue: 'feedback', actionType: 'suppress_mirror' });
    assert.match(add.headers.get('location')!, /ok=/);
    const bad = await browser.form(`${g}/rules`, { _csrf: csrf, conditionType: 'severity_gte', conditionValue: 'enormous', actionType: 'mirror' });
    assert.match(bad.headers.get('location')!, /err=/);
    assert.ok((await (await browser.fetch(`${g}/rules`)).text()).includes('Category is &quot;feedback&quot; → Do NOT mirror'));

    // another admin's guild ids are not reachable
    assert.equal((await browser.fetch('/dashboard/g/999999999999999999')).status, 404);
  });

  it('never logs secrets', () => {
    for (const secret of ['e2e-bot-token-not-real', 'e2e-client-secret', 'e2e-groq-key', '/services/slack-mirror', firstReport.token]) {
      assert.ok(!app.logs.includes(secret), `logs leaked ${secret}`);
    }
  });
});

import './setup-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseReportButtonId, reportButtonId } from '../../src/discord/commands.js';
import { findModalValue, snowflakeTime } from '../../src/discord/types.js';
import { normalizeSettings } from '../../src/domain.js';
import { backoffMs } from '../../src/jobs/queue.js';
import { decrypt, encrypt, hashPassword, verifyPassword } from '../../src/lib/crypto.js';
import { html } from '../../src/lib/html.js';
import { redact, redactDeep, registerSecret } from '../../src/lib/redact.js';
import { classifyWebhookUrl } from '../../src/services/mirror.js';
import { heuristicTriage } from '../../src/services/triage.js';

describe('redaction', () => {
  it('scrubs webhook URLs, interaction tokens and auth headers', () => {
    const s = redact(
      'POST https://discord.com/api/v10/webhooks/123456/aW50ZXJhY3Rpb246MTIzNDU2Nzg5MDpzZWNyZXQ failed; ' +
        'slack https://hooks.slack.com/services/T000/B000/XXXXXXXX; Authorization: Bot abcdefghijklmnop.qrstuv',
    );
    assert.ok(!s.includes('aW50ZXJhY3Rpb24'));
    assert.ok(!s.includes('T000/B000'));
    assert.ok(!s.includes('abcdefghijklmnop'));
  });

  it('scrubs registered secret values and drops secret-named keys', () => {
    registerSecret('super-secret-value-123');
    assert.equal(redact('x super-secret-value-123 y'), 'x [REDACTED] y');
    assert.deepEqual(redactDeep({ token: 'abc', nested: { password: 'p', ok: 'fine' } }), { token: '[REDACTED]', nested: { password: '[REDACTED]', ok: 'fine' } });
  });
});

describe('mirror webhook validation (SSRF guard)', () => {
  it('accepts real Slack and Discord webhook URLs', () => {
    assert.equal(classifyWebhookUrl('https://hooks.slack.com/services/T000/B000/XXXX'), 'slack');
    assert.equal(classifyWebhookUrl('https://discord.com/api/webhooks/123456789/abc-DEF_123'), 'discord');
  });
  it('rejects everything else', () => {
    for (const u of [
      'http://hooks.slack.com/services/T/B/X',
      'https://evil.com/services/T/B/X',
      'https://hooks.slack.com.evil.com/services/T/B/X',
      'https://discord.com/api/users/@me',
      'https://user:pass@discord.com/api/webhooks/1/a',
      'http://169.254.169.254/latest/meta-data',
      'not a url',
    ]) {
      assert.equal(classifyWebhookUrl(u), null, u);
    }
  });
});

describe('crypto', () => {
  it('round-trips at-rest encryption and detects tampering', () => {
    const c = encrypt('https://hooks.slack.com/services/a/b/c');
    assert.equal(decrypt(c), 'https://hooks.slack.com/services/a/b/c');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => decrypt(parts.join('.')));
  });
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse');
    assert.equal(await verifyPassword('correct horse', h), true);
    assert.equal(await verifyPassword('wrong', h), false);
  });
});

describe('html template', () => {
  it('escapes interpolations', () => {
    assert.equal(html`<p>${'<script>alert(1)</script>'}</p>`.value, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    assert.equal(html`<a title="${'" onmouseover="x'}">`.value, '<a title="&quot; onmouseover=&quot;x">');
  });
});

describe('discord helpers', () => {
  it('round-trips button custom ids and rejects junk', () => {
    assert.deepEqual(parseReportButtonId(reportButtonId('resolve', 42)), { action: 'resolve', reportId: 42 });
    assert.equal(parseReportButtonId('report:delete:1'), null);
    assert.equal(parseReportButtonId('report:ack:1; DROP TABLE'), null);
  });
  it('finds modal values in classic and label-style payloads', () => {
    const classic = [{ type: 1, components: [{ type: 4, custom_id: 'report_text', value: 'hello' }] }];
    const labelled = [{ type: 18, component: { type: 4, custom_id: 'report_text', value: 'hi' } }];
    assert.equal(findModalValue(classic, 'report_text'), 'hello');
    assert.equal(findModalValue(labelled, 'report_text'), 'hi');
    assert.equal(findModalValue(classic, 'missing'), undefined);
  });
  it('decodes snowflake timestamps', () => {
    assert.equal(snowflakeTime('175928847299117063').toISOString(), '2016-04-30T11:18:25.796Z');
  });
});

describe('triage heuristics', () => {
  it('classifies obvious incidents and questions', () => {
    assert.equal(heuristicTriage('The whole site is down, outage!').severity, 'critical');
    assert.equal(heuristicTriage('The whole site is down, outage!').category, 'incident');
    assert.equal(heuristicTriage('How do I change my avatar?').category, 'question');
  });
});

describe('settings & backoff', () => {
  it('fills defaults and clamps values', () => {
    const s = normalizeSettings({ commands: { report: { cooldownSeconds: 99999 } }, simulateMirrorFailures: -5 });
    assert.equal(s.commands.report.cooldownSeconds, 3600);
    assert.equal(s.commands.report.enabled, true);
    assert.equal(s.simulateMirrorFailures, 0);
  });
  it('backs off exponentially with a cap and honours retry-after', () => {
    assert.ok(backoffMs(1) >= 1600 && backoffMs(1) <= 2400);
    assert.ok(backoffMs(20) <= 360_000);
    assert.ok(backoffMs(1, 30_000) >= 30_000);
  });
});

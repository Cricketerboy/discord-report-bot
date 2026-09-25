import './setup-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Rule } from '../../src/domain.js';
import { evaluateRules, validateRule } from '../../src/services/rules.js';

let nextId = 1;
const rule = (p: Partial<Rule>): Rule => ({
  id: nextId++,
  position: nextId * 10,
  enabled: true,
  conditionType: 'always',
  conditionValue: '',
  actionType: 'mirror',
  actionValue: '',
  ...p,
});

describe('evaluateRules', () => {
  it('escalates severity on keyword match, then later rules see the new severity', () => {
    const rules = [
      rule({ conditionType: 'keyword', conditionValue: 'outage, down', actionType: 'set_severity', actionValue: 'critical' }),
      rule({ conditionType: 'severity_gte', conditionValue: 'high', actionType: 'mention_role', actionValue: '' }),
    ];
    const out = evaluateRules(rules, { text: 'The site is DOWN for everyone', severity: 'low', category: 'bug' }, { alertRoleId: '222222222222222222' });
    assert.equal(out.severity, 'critical');
    assert.deepEqual(out.mentionRoleIds, ['222222222222222222']);
    assert.equal(out.matched.length, 2);
  });

  it('matches whole words only', () => {
    const rules = [rule({ conditionType: 'keyword', conditionValue: 'down', actionType: 'set_severity', actionValue: 'critical' })];
    const out = evaluateRules(rules, { text: 'please download the file', severity: 'low', category: 'question' }, { alertRoleId: null });
    assert.equal(out.severity, 'low');
  });

  it('suppress_mirror wins over mirror', () => {
    const rules = [rule({ actionType: 'mirror' }), rule({ conditionType: 'category_is', conditionValue: 'question', actionType: 'suppress_mirror' })];
    assert.equal(evaluateRules(rules, { text: 'how?', severity: 'low', category: 'question' }, { alertRoleId: null }).mirror, false);
    assert.equal(evaluateRules(rules, { text: 'bug', severity: 'low', category: 'bug' }, { alertRoleId: null }).mirror, true);
  });

  it('ignores disabled rules and mention rules with no role available', () => {
    const rules = [rule({ enabled: false, actionType: 'mirror' }), rule({ actionType: 'mention_role', actionValue: '' })];
    const out = evaluateRules(rules, { text: 'x', severity: 'low', category: 'other' }, { alertRoleId: null });
    assert.equal(out.mirror, false);
    assert.deepEqual(out.mentionRoleIds, []);
    assert.equal(out.matched.length, 0);
  });

  it('collects reply notes', () => {
    const rules = [rule({ conditionType: 'category_is', conditionValue: 'question', actionType: 'reply_note', actionValue: 'See #faq' })];
    assert.deepEqual(evaluateRules(rules, { text: '?', severity: 'low', category: 'question' }, { alertRoleId: null }).notes, ['See #faq']);
  });
});

describe('validateRule', () => {
  it('normalizes keywords', () => {
    const v = validateRule({ conditionType: 'keyword', conditionValue: ' Refund ,  PAYMENT,, ', actionType: 'mirror', actionValue: 'ignored' });
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.rule.conditionValue, 'refund, payment');
      assert.equal(v.rule.actionValue, '');
    }
  });

  it('rejects unknown types and bad values', () => {
    assert.equal(validateRule({ conditionType: 'eval', actionType: 'mirror' }).ok, false);
    assert.equal(validateRule({ conditionType: 'severity_gte', conditionValue: 'huge', actionType: 'mirror' }).ok, false);
    assert.equal(validateRule({ conditionType: 'always', actionType: 'set_severity', actionValue: 'nope' }).ok, false);
    assert.equal(validateRule({ conditionType: 'always', actionType: 'mention_role', actionValue: '<@&1>' }).ok, false);
  });
});

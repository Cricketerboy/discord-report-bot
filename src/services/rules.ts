import { CATEGORIES, SEVERITIES, isCategory, isSeverity, severityRank, type Category, type Rule, type Severity } from '../domain.js';

export const CONDITION_TYPES = {
  always: 'Always',
  keyword: 'Text contains any of',
  severity_gte: 'Severity is at least',
  category_is: 'Category is',
} as const;

export const ACTION_TYPES = {
  set_severity: 'Set severity to',
  mention_role: 'Mention role',
  mirror: 'Mirror to second channel',
  suppress_mirror: 'Do NOT mirror',
  reply_note: 'Add note to reply',
} as const;

export type ConditionType = keyof typeof CONDITION_TYPES;
export type ActionType = keyof typeof ACTION_TYPES;

export interface RuleInput {
  text: string;
  severity: Severity;
  category: Category;
}

export interface RuleOutcome {
  severity: Severity;
  mentionRoleIds: string[];
  mirror: boolean;
  notes: string[];
  matched: Array<{ id: number; description: string }>;
}

function keywords(value: string): string[] {
  return value
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function conditionMatches(rule: Pick<Rule, 'conditionType' | 'conditionValue'>, input: RuleInput): boolean {
  switch (rule.conditionType) {
    case 'always':
      return true;
    case 'keyword': {
      const text = input.text.toLowerCase();
      return keywords(rule.conditionValue).some((k) => new RegExp(`(^|\\W)${escapeRegex(k)}($|\\W)`, 'u').test(text));
    }
    case 'severity_gte':
      return isSeverity(rule.conditionValue) && severityRank(input.severity) >= severityRank(rule.conditionValue);
    case 'category_is':
      return input.category === rule.conditionValue;
    default:
      return false;
  }
}

export function describeRule(rule: Pick<Rule, 'conditionType' | 'conditionValue' | 'actionType' | 'actionValue'>): string {
  const cond = CONDITION_TYPES[rule.conditionType as ConditionType] ?? rule.conditionType;
  const act = ACTION_TYPES[rule.actionType as ActionType] ?? rule.actionType;
  const condPart = rule.conditionType === 'always' ? cond : `${cond} "${rule.conditionValue}"`;
  const actPart =
    rule.actionType === 'mention_role'
      ? `${act}${rule.actionValue ? ` <@&${rule.actionValue}>` : ' (server alert role)'}`
      : rule.actionValue
        ? `${act} "${rule.actionValue}"`
        : act;
  return `${condPart} → ${actPart}`;
}

/**
 * Two passes: severity overrides first (in position order, each seeing the result of the previous),
 * then every other action is evaluated against the final severity. Pure and deterministic.
 */
export function evaluateRules(rules: Rule[], input: RuleInput, ctx: { alertRoleId: string | null }): RuleOutcome {
  const active = rules.filter((r) => r.enabled).sort((a, b) => a.position - b.position || a.id - b.id);
  const matched: RuleOutcome['matched'] = [];
  let severity = input.severity;

  for (const rule of active.filter((r) => r.actionType === 'set_severity')) {
    if (isSeverity(rule.actionValue) && conditionMatches(rule, { ...input, severity })) {
      severity = rule.actionValue;
      matched.push({ id: rule.id, description: describeRule(rule) });
    }
  }

  const mentionRoleIds = new Set<string>();
  const notes: string[] = [];
  let mirror = false;
  let suppress = false;
  for (const rule of active.filter((r) => r.actionType !== 'set_severity')) {
    if (!conditionMatches(rule, { ...input, severity })) continue;
    switch (rule.actionType) {
      case 'mention_role': {
        const roleId = rule.actionValue || ctx.alertRoleId;
        if (!roleId) continue; // nothing to mention; don't count it as matched
        mentionRoleIds.add(roleId);
        break;
      }
      case 'mirror':
        mirror = true;
        break;
      case 'suppress_mirror':
        suppress = true;
        break;
      case 'reply_note':
        if (rule.actionValue) notes.push(rule.actionValue);
        break;
      default:
        continue;
    }
    matched.push({ id: rule.id, description: describeRule(rule) });
  }

  return { severity, mentionRoleIds: [...mentionRoleIds], mirror: mirror && !suppress, notes, matched };
}

export type RuleDraft = Omit<Rule, 'id' | 'position' | 'enabled'>;

/** Validates admin-submitted rule fields; returns an error message or the normalized rule. */
export function validateRule(raw: Record<string, unknown>): { ok: true; rule: RuleDraft } | { ok: false; error: string } {
  const conditionType = String(raw.conditionType ?? '');
  const actionType = String(raw.actionType ?? '');
  let conditionValue = String(raw.conditionValue ?? '').trim();
  let actionValue = String(raw.actionValue ?? '').trim();

  if (!(conditionType in CONDITION_TYPES)) return { ok: false, error: 'Unknown condition type' };
  if (!(actionType in ACTION_TYPES)) return { ok: false, error: 'Unknown action type' };

  if (conditionType === 'always') conditionValue = '';
  if (conditionType === 'keyword') {
    if (!keywords(conditionValue).length) return { ok: false, error: 'Enter at least one keyword (comma separated)' };
    if (conditionValue.length > 300) return { ok: false, error: 'Keyword list is too long (max 300 chars)' };
    conditionValue = keywords(conditionValue).join(', ');
  }
  if (conditionType === 'severity_gte' && !isSeverity(conditionValue)) return { ok: false, error: `Severity must be one of ${SEVERITIES.join(', ')}` };
  if (conditionType === 'category_is' && !isCategory(conditionValue)) return { ok: false, error: `Category must be one of ${CATEGORIES.join(', ')}` };

  if (actionType === 'set_severity' && !isSeverity(actionValue)) return { ok: false, error: `Severity must be one of ${SEVERITIES.join(', ')}` };
  if (actionType === 'mention_role' && actionValue && !/^\d{15,25}$/.test(actionValue)) return { ok: false, error: 'Pick a role (or leave empty to use the alert role)' };
  if (actionType === 'reply_note') {
    if (!actionValue) return { ok: false, error: 'Enter the note text' };
    if (actionValue.length > 300) return { ok: false, error: 'Note is too long (max 300 chars)' };
  }
  if (actionType === 'mirror' || actionType === 'suppress_mirror') actionValue = '';

  return { ok: true, rule: { conditionType, conditionValue, actionType, actionValue } };
}

export const DEFAULT_RULES: RuleDraft[] = [
  { conditionType: 'keyword', conditionValue: 'outage, down, security, breach, hacked, urgent', actionType: 'set_severity', actionValue: 'critical' },
  { conditionType: 'severity_gte', conditionValue: 'high', actionType: 'mention_role', actionValue: '' },
  { conditionType: 'always', conditionValue: '', actionType: 'mirror', actionValue: '' },
  { conditionType: 'category_is', conditionValue: 'question', actionType: 'reply_note', actionValue: 'Questions are usually answered fastest in #help.' },
];

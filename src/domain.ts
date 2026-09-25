export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ['bug', 'incident', 'question', 'feedback', 'abuse', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const REPORT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);
}

export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}

export interface GuildSettings {
  commands: {
    report: { enabled: boolean; ephemeral: boolean; cooldownSeconds: number };
    status: { enabled: boolean; ephemeral: boolean };
  };
  aiEnabled: boolean;
  resolveRequiresManageMessages: boolean;
  /** Fault injection: the next N mirror sends fail with a retryable error, to demo retries. */
  simulateMirrorFailures: number;
}

export const DEFAULT_SETTINGS: GuildSettings = {
  commands: {
    report: { enabled: true, ephemeral: true, cooldownSeconds: 20 },
    status: { enabled: true, ephemeral: false },
  },
  aiEnabled: true,
  resolveRequiresManageMessages: true,
  simulateMirrorFailures: 0,
};

/** Merges stored (possibly partial / older-shaped) settings over defaults. */
export function normalizeSettings(raw: unknown): GuildSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<GuildSettings> & { commands?: Partial<GuildSettings['commands']> };
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const int = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
  const d = DEFAULT_SETTINGS;
  return {
    commands: {
      report: {
        enabled: bool(r.commands?.report?.enabled, d.commands.report.enabled),
        ephemeral: bool(r.commands?.report?.ephemeral, d.commands.report.ephemeral),
        cooldownSeconds: int(r.commands?.report?.cooldownSeconds, d.commands.report.cooldownSeconds, 0, 3600),
      },
      status: {
        enabled: bool(r.commands?.status?.enabled, d.commands.status.enabled),
        ephemeral: bool(r.commands?.status?.ephemeral, d.commands.status.ephemeral),
      },
    },
    aiEnabled: bool(r.aiEnabled, d.aiEnabled),
    resolveRequiresManageMessages: bool(r.resolveRequiresManageMessages, d.resolveRequiresManageMessages),
    simulateMirrorFailures: int(r.simulateMirrorFailures, 0, 0, 20),
  };
}

export interface Rule {
  id: number;
  position: number;
  enabled: boolean;
  conditionType: string;
  conditionValue: string;
  actionType: string;
  actionValue: string;
}

export interface GuildConfig {
  id: string;
  name: string;
  icon: string | null;
  reportChannelId: string | null;
  reportChannelName: string | null;
  alertRoleId: string | null;
  mirrorKind: string | null;
  mirrorHint: string | null;
  settings: GuildSettings;
  rules: Rule[];
  commandsSyncedAt: Date | null;
}

export interface Report {
  id: number;
  guildId: string;
  interactionId: string;
  channelId: string | null;
  userId: string | null;
  userName: string | null;
  text: string;
  source: string;
  severity: Severity;
  category: Category;
  summary: string | null;
  tags: string[];
  aiStatus: string;
  aiModel: string | null;
  matchedRules: Array<{ id: number; description: string }>;
  mentions: string[];
  notes: string[];
  mirror: boolean;
  status: ReportStatus;
  statusBy: string | null;
  statusAt: Date | null;
  channelMessageId: string | null;
  createdAt: Date;
}

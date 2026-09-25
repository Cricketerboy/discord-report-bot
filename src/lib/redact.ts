/**
 * Scrubs secrets out of strings before they reach logs, the database or the dashboard.
 * Two layers: exact known secret values (registered at boot / when decrypted) and
 * shape-based patterns for things that are secret by construction (webhook URLs, tokens).
 */

const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

const PATTERNS: Array<[RegExp, string]> = [
  // Discord webhook / interaction follow-up URLs carry a token in the last path segment.
  [/(https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/)[\w.-]+/gi, '$1[REDACTED]'],
  [/(\/webhooks\/\d+\/)[\w.-]{20,}/g, '$1[REDACTED]'],
  [/https?:\/\/hooks\.slack\.com\/[\w/.-]+/gi, 'https://hooks.slack.com/[REDACTED]'],
  [/(Bot|Bearer|Basic)\s+[\w.\-=+/]{10,}/g, '$1 [REDACTED]'],
  [/gsk_[\w]{10,}/g, 'gsk_[REDACTED]'],
  // Discord bot tokens: base64(user id).timestamp.hmac
  [/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,40}/g, '[REDACTED_TOKEN]'],
  [/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://[REDACTED]'],
];

export function redact(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Deep-redacts any JSON-ish value. Keys that are secret by name are dropped entirely. */
const SECRET_KEYS = /^(token|access_token|password|password_hash|authorization|cookie|secret|webhook_url|mirror_webhook_url)$/i;

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redactDeep(v);
    }
    return out as T;
  }
  return value;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? ` (cause: ${cause.message})` : '';
    return redact(`${err.message}${causeMsg}`).slice(0, 1000);
  }
  return redact(String(err)).slice(0, 1000);
}

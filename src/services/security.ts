import { logger } from '../logger.js';
import { notifyChange } from './events.js';

/**
 * Rejected (unsigned / forged / replayed) requests are counted in memory rather than written to the
 * database: junk traffic must not be able to amplify into DB writes. Counters reset on restart.
 */
const counts = new Map<string, number>();
const recent: Array<{ at: string; reason: string; ip: string }> = [];
const startedAt = new Date();

export function recordRejectedRequest(reason: string, ip: string): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
  recent.unshift({ at: new Date().toISOString(), reason, ip: maskIp(ip) });
  if (recent.length > 25) recent.length = 25;
  logger.warn({ kind: 'security.rejected', reason, ip: maskIp(ip) }, 'rejected interaction request');
  notifyChange(null);
}

function maskIp(ip: string): string {
  if (ip.includes('.')) return ip.split('.').slice(0, 2).concat(['x', 'x']).join('.');
  return ip.split(':').slice(0, 3).join(':') + ':…';
}

export function securitySnapshot() {
  return {
    since: startedAt,
    total: [...counts.values()].reduce((a, b) => a + b, 0),
    byReason: Object.fromEntries(counts),
    recent: [...recent],
  };
}

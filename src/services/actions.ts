import type { Queryable } from '../db/pool.js';
import type { ReportAction } from '../discord/commands.js';
import { enqueue } from '../jobs/queue.js';
import { changeReportStatus } from './reports.js';

/**
 * Applies a button action to a report and, only if the status actually changed, queues the mirror
 * notification — in the same transaction, so "status changed" and "notification owed" can't diverge.
 */
export async function applyReportAction(
  db: Queryable,
  args: { reportId: number; guildId: string; action: ReportAction; by: string; interactionId: string },
) {
  const result = await changeReportStatus(db, args);
  if (result.changed && result.report?.mirror) {
    await enqueue(db, {
      kind: 'mirror.send',
      dedupeKey: `mirror.send:status:${args.interactionId}`,
      guildId: args.guildId,
      interactionId: args.interactionId,
      payload: { reportId: args.reportId, event: 'status', status: result.report.status, by: args.by },
    });
  }
  return result;
}

/** Slash command definitions registered (bulk-overwritten) per connected guild. */
export const COMMANDS = [
  {
    name: 'report',
    type: 1,
    description: 'File a report. Leave text empty to open a form.',
    options: [
      {
        type: 3, // STRING
        name: 'text',
        description: 'What happened?',
        required: false,
        min_length: 3,
        max_length: 1000,
      },
    ],
  },
  {
    name: 'status',
    type: 1,
    description: 'Show open reports and bot health for this server.',
  },
] as const;

export const REPORT_MODAL_ID = 'report_modal';
export const REPORT_MODAL_INPUT_ID = 'report_text';

export function reportModal() {
  return {
    custom_id: REPORT_MODAL_ID,
    title: 'File a report',
    components: [
      {
        type: 1,
        components: [
          {
            type: 4, // TEXT_INPUT
            custom_id: REPORT_MODAL_INPUT_ID,
            style: 2, // PARAGRAPH
            label: 'What happened?',
            placeholder: 'Describe the problem, where you saw it and how bad it is.',
            min_length: 3,
            max_length: 1000,
            required: true,
          },
        ],
      },
    ],
  };
}

export type ReportAction = 'ack' | 'resolve' | 'reopen';

export function reportButtonId(action: ReportAction, reportId: number): string {
  return `report:${action}:${reportId}`;
}

export function parseReportButtonId(customId: string | undefined): { action: ReportAction; reportId: number } | null {
  const m = /^report:(ack|resolve|reopen):(\d{1,12})$/.exec(customId ?? '');
  if (!m) return null;
  return { action: m[1] as ReportAction, reportId: Number(m[2]) };
}

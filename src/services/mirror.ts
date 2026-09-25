import { config } from '../config.js';
import { request } from '../lib/http.js';

export type MirrorKind = 'slack' | 'discord';

/**
 * Only real Slack / Discord webhook URLs are accepted. This keeps an admin from turning the
 * mirror into an SSRF primitive against arbitrary hosts.
 */
export function classifyWebhookUrl(raw: string): MirrorKind | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (config.MIRROR_ALLOW_ANY_HOST && (url.protocol === 'http:' || url.protocol === 'https:')) {
    return url.pathname.includes('slack') ? 'slack' : 'discord';
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (url.hostname === 'hooks.slack.com' && /^\/services\/[\w/]+$/.test(url.pathname)) return 'slack';
  if (
    ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(url.hostname) &&
    /^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)
  ) {
    return 'discord';
  }
  return null;
}

/** A non-secret hint so admins can tell which webhook is configured without revealing it. */
export function webhookHint(raw: string, kind: MirrorKind): string {
  const tail = raw.trim().replace(/\/+$/, '').slice(-4);
  return kind === 'slack' ? `Slack webhook …${tail}` : `Discord webhook …${tail}`;
}

export interface MirrorMessage {
  title: string;
  body: string;
  fields: Array<{ name: string; value: string }>;
  color: number;
  footer: string;
}

// Slack treats <...> as control sequences (<!channel>, <@U123>); escaping stops user text from pinging.
function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendMirror(url: string, kind: MirrorKind, msg: MirrorMessage): Promise<void> {
  if (kind === 'slack') {
    const fieldsText = msg.fields.map((f) => `*${slackEscape(f.name)}:* ${slackEscape(f.value)}`).join('   ');
    await request(url, {
      method: 'POST',
      json: {
        text: `${msg.title}: ${msg.body}`.slice(0, 3000),
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: msg.title.slice(0, 150), emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: slackEscape(msg.body).slice(0, 2900) || '_(no text)_' } },
          ...(fieldsText ? [{ type: 'section', text: { type: 'mrkdwn', text: fieldsText.slice(0, 2900) } }] : []),
          { type: 'context', elements: [{ type: 'mrkdwn', text: slackEscape(msg.footer).slice(0, 300) }] },
        ],
      },
      timeoutMs: 8000,
      label: 'mirror.slack',
    });
    return;
  }
  const u = new URL(url);
  u.searchParams.set('wait', 'true');
  await request(u.toString(), {
    method: 'POST',
    json: {
      username: 'Report Bot',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: msg.title.slice(0, 256),
          description: msg.body.slice(0, 4000),
          color: msg.color,
          fields: msg.fields.slice(0, 10).map((f) => ({ name: f.name.slice(0, 256), value: f.value.slice(0, 1024) || '—', inline: true })),
          footer: { text: msg.footer.slice(0, 2000) },
        },
      ],
    },
    timeoutMs: 8000,
    label: 'mirror.discord',
  });
}

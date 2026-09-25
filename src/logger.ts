import pino from 'pino';
import { config } from './config.js';
import { redact, registerSecret } from './lib/redact.js';

for (const secret of [
  config.DISCORD_BOT_TOKEN,
  config.DISCORD_CLIENT_SECRET,
  config.APP_SECRET,
  config.GROQ_API_KEY,
  config.DATABASE_URL,
  config.ADMIN_PASSWORD,
]) {
  registerSecret(secret);
}

/**
 * Structured JSON logs to stdout. Every string that passes through is scrubbed by `redact`,
 * and well-known secret fields are censored by path as a second line of defence.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'discord-report-bot' },
  redact: {
    paths: ['token', '*.token', 'password', '*.password', 'authorization', '*.authorization', 'headers.authorization', 'headers.cookie', 'webhookUrl', '*.webhookUrl'],
    censor: '[REDACTED]',
  },
  hooks: {
    logMethod(args, method) {
      method.apply(
        this,
        args.map((a) => (typeof a === 'string' ? redact(a) : a)) as Parameters<typeof method>,
      );
    },
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

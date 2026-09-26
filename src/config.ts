import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Public URL of this deployment, e.g. https://my-bot.onrender.com (Render also exposes RENDER_EXTERNAL_URL).
  PUBLIC_BASE_URL: z.string().url().optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(5),

  // Used to derive the session-signing and at-rest encryption keys. 32+ random chars.
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),

  DISCORD_APPLICATION_ID: z.string().regex(/^\d{15,25}$/, 'DISCORD_APPLICATION_ID must be a numeric snowflake'),
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'DISCORD_PUBLIC_KEY must be 64 hex characters'),
  DISCORD_BOT_TOKEN: z.string().min(20, 'DISCORD_BOT_TOKEN is required'),
  DISCORD_CLIENT_SECRET: z.string().min(8, 'DISCORD_CLIENT_SECRET is required'),
  DISCORD_API_BASE: z.string().url().default('https://discord.com/api/v10'),

  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('openai/gpt-oss-20b'),
  GROQ_API_BASE: z.string().url().default('https://api.groq.com/openai/v1'),

  // Optional: create/refresh an admin account on boot (handy for a throwaway reviewer login).
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  ALLOW_SIGNUP: bool(false),

  // Keeps a free Render instance from idling out (Discord does not retry interactions to a sleeping host).
  KEEPALIVE: bool(true),
  SPOOL_DIR: z.string().default('.data'),

  // Test-only escape hatch so e2e tests can point the mirror at a local mock server. Ignored outside NODE_ENV=test.
  MIRROR_ALLOW_ANY_HOST: bool(false),
});

export type Config = z.infer<typeof schema> & { baseUrl: string };

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Only variable names and messages are printed, never values.
    console.error(`Invalid environment configuration:\n${problems}\nSee .env.example.`);
    process.exit(1);
  }
  const env = parsed.data;
  const baseUrl = (env.PUBLIC_BASE_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, '');
  return {
    ...env,
    MIRROR_ALLOW_ANY_HOST: env.NODE_ENV === 'test' && env.MIRROR_ALLOW_ANY_HOST,
    baseUrl,
  };
}

export const config: Config = load();
export const isProd = config.NODE_ENV === 'production';

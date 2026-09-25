// Imported first by every unit test so `src/config.ts` sees a complete (fake) environment.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:1/unused';
process.env.APP_SECRET ??= 'unit-test-secret-unit-test-secret-0123456789';
process.env.DISCORD_APPLICATION_ID ??= '111111111111111111';
process.env.DISCORD_PUBLIC_KEY ??= '0'.repeat(64);
process.env.DISCORD_BOT_TOKEN ??= 'fake-bot-token-for-unit-tests';
process.env.DISCORD_CLIENT_SECRET ??= 'fake-client-secret';

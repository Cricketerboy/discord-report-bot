// Applies the (idempotent) schema. The server also does this on boot; this is for manual setup/CI.
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';

await migrate();
await pool.end();
console.log('Schema is up to date.');

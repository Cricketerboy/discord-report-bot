// Manually (re-)register slash commands.
//   npm run commands:register -- <guildId>   -> guild commands (instant; what the dashboard does on connect)
//   npm run commands:register -- --global    -> global commands (can take a while to appear)
// Don't use both for the same app, or users will see each command twice.
import { overwriteGlobalCommands, overwriteGuildCommands } from '../src/discord/api.js';
import { COMMANDS } from '../src/discord/commands.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run commands:register -- <guildId> | --global');
  process.exit(1);
}
if (arg === '--global') {
  await overwriteGlobalCommands([...COMMANDS]);
  console.log('Registered global commands:', COMMANDS.map((c) => `/${c.name}`).join(', '));
} else if (/^\d{15,25}$/.test(arg)) {
  await overwriteGuildCommands(arg, [...COMMANDS]);
  console.log(`Registered commands in guild ${arg}:`, COMMANDS.map((c) => `/${c.name}`).join(', '));
} else {
  console.error('Guild id must be a numeric Discord snowflake.');
  process.exit(1);
}

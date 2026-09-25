// Throws junk at a deployed interactions endpoint and checks every request is refused.
//   npm run probe -- https://your-app.onrender.com
// Needs no secrets: without Discord's private key, none of these can be valid.
import { generateKeyPairSync, sign } from 'node:crypto';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: npm run probe -- https://your-app.onrender.com');
  process.exit(1);
}
const url = `${base}/interactions`;
const now = () => String(Math.floor(Date.now() / 1000));
const ping = JSON.stringify({ id: '1234567890123456789', application_id: '1234567890123456789', type: 1, token: 'x', version: 1 });
const { privateKey } = generateKeyPairSync('ed25519'); // attacker's own key: valid format, wrong signer
const forged = (ts: string, body: string) => sign(null, Buffer.from(ts + body), privateKey).toString('hex');

const cases: Array<{ name: string; headers: Record<string, string>; body: string }> = [
  { name: 'no signature headers', headers: {}, body: ping },
  { name: 'garbage signature', headers: { 'x-signature-ed25519': 'abc', 'x-signature-timestamp': now() }, body: ping },
  { name: 'well-formed signature from the wrong key', headers: { 'x-signature-ed25519': forged(now(), ping), 'x-signature-timestamp': now() }, body: ping },
  { name: 'stale timestamp (replay)', headers: { 'x-signature-ed25519': forged('1600000000', ping), 'x-signature-timestamp': '1600000000' }, body: ping },
  { name: 'empty body', headers: { 'x-signature-ed25519': 'a'.repeat(128), 'x-signature-timestamp': now() }, body: '' },
  { name: 'not JSON', headers: { 'x-signature-ed25519': 'a'.repeat(128), 'x-signature-timestamp': now() }, body: 'hello' },
];

let failed = 0;
for (const c of cases) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...c.headers }, body: c.body || undefined });
  const ok = res.status === 401;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(res.status).padEnd(4)} ${c.name}`);
}
console.log(failed ? `\n${failed} probe(s) were NOT rejected with 401.` : '\nAll junk requests were rejected with 401.');
process.exit(failed ? 1 : 0);

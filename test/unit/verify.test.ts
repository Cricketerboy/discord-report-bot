import './setup-env.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { publicKeyFromHex, verifyDiscordRequest } from '../../src/discord/verify.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
const key = publicKeyFromHex(rawHex);
const other = generateKeyPairSync('ed25519');

const body = Buffer.from(JSON.stringify({ id: '1', type: 1 }));
const now = 1_750_000_000;
const ts = String(now);
const sig = (t: string, b: Buffer, k = privateKey) => sign(null, Buffer.concat([Buffer.from(t), b]), k).toString('hex');

describe('verifyDiscordRequest', () => {
  it('accepts a correctly signed request', () => {
    assert.deepEqual(verifyDiscordRequest({ signature: sig(ts, body), timestamp: ts, rawBody: body, publicKey: key, nowSeconds: now }), { ok: true });
  });

  it('rejects missing headers', () => {
    const r = verifyDiscordRequest({ signature: undefined, timestamp: ts, rawBody: body, publicKey: key, nowSeconds: now });
    assert.equal(r.ok, false);
  });

  it('rejects a signature made with another key', () => {
    const r = verifyDiscordRequest({ signature: sig(ts, body, other.privateKey), timestamp: ts, rawBody: body, publicKey: key, nowSeconds: now });
    assert.deepEqual(r, { ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ id: '1', type: 2 }));
    const r = verifyDiscordRequest({ signature: sig(ts, body), timestamp: ts, rawBody: tampered, publicKey: key, nowSeconds: now });
    assert.deepEqual(r, { ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered timestamp (timestamp is covered by the signature)', () => {
    const r = verifyDiscordRequest({ signature: sig(ts, body), timestamp: String(now + 1), rawBody: body, publicKey: key, nowSeconds: now });
    assert.deepEqual(r, { ok: false, reason: 'bad_signature' });
  });

  it('rejects a validly signed but stale request (replay window)', () => {
    const old = String(now - 3600);
    const r = verifyDiscordRequest({ signature: sig(old, body), timestamp: old, rawBody: body, publicKey: key, nowSeconds: now });
    assert.deepEqual(r, { ok: false, reason: 'stale_timestamp' });
  });

  it('rejects malformed signatures and timestamps without throwing', () => {
    assert.equal(verifyDiscordRequest({ signature: 'zz', timestamp: ts, rawBody: body, publicKey: key, nowSeconds: now }).ok, false);
    assert.equal(verifyDiscordRequest({ signature: sig(ts, body), timestamp: 'abc', rawBody: body, publicKey: key, nowSeconds: now }).ok, false);
    assert.equal(verifyDiscordRequest({ signature: sig(ts, body), timestamp: ts, rawBody: Buffer.alloc(0), publicKey: key, nowSeconds: now }).ok, false);
  });
});

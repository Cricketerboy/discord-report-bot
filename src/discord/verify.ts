import { createPublicKey, verify, type KeyObject } from 'node:crypto';

// DER prefix that wraps a raw 32-byte Ed25519 public key into an SPKI structure Node can load.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromHex(hex: string): KeyObject {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyInput {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | undefined;
  publicKey: KeyObject;
  nowSeconds?: number;
  /** Requests whose signed timestamp is further than this from now are treated as replays. */
  maxSkewSeconds?: number;
}

/**
 * Verifies Discord's Ed25519 request signature over `timestamp + rawBody`.
 * The timestamp is covered by the signature, so bounding its age also bounds how long a
 * captured request could be replayed; within that window the interaction-id dedup takes over.
 */
export function verifyDiscordRequest(input: VerifyInput): VerifyResult {
  const { signature, timestamp, rawBody, publicKey } = input;
  if (!signature || !timestamp) return { ok: false, reason: 'missing_signature_headers' };
  if (!/^[0-9a-f]{128}$/i.test(signature)) return { ok: false, reason: 'malformed_signature' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'malformed_timestamp' };
  if (!rawBody || rawBody.length === 0) return { ok: false, reason: 'empty_body' };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxSkew = input.maxSkewSeconds ?? 300;
  if (Math.abs(now - Number(timestamp)) > maxSkew) return { ok: false, reason: 'stale_timestamp' };

  let valid = false;
  try {
    valid = verify(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]), publicKey, Buffer.from(signature, 'hex'));
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

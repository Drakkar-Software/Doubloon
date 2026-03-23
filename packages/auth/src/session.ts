import nacl from 'tweetnacl';
import { DoubloonError } from '@doubloon/core';

export function createSessionToken(
  wallet: string,
  serverPrivateKey: Uint8Array,
  ttlMinutes: number,
): string {
  const now = Date.now();
  const payload = JSON.stringify({
    w: wallet,
    e: now + ttlMinutes * 60_000,
    i: now,
  });
  const payloadBytes = new TextEncoder().encode(payload);
  const signature = nacl.sign.detached(payloadBytes, serverPrivateKey);
  return `${base64url(payloadBytes)}.${base64url(signature)}`;
}

export function verifySessionToken(
  token: string,
  serverPublicKey: Uint8Array,
): { wallet: string; expiresAt: Date } {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new DoubloonError('SIGNATURE_INVALID', 'Malformed session token');
  }

  const payloadBytes = fromBase64url(parts[0]);
  const signature = fromBase64url(parts[1]);

  const valid = nacl.sign.detached.verify(payloadBytes, signature, serverPublicKey);
  if (!valid) {
    throw new DoubloonError('SIGNATURE_INVALID', 'Invalid session token signature');
  }

  let payload: { w?: unknown; e?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new DoubloonError('SIGNATURE_INVALID', 'Malformed session token payload');
  }

  if (typeof payload.w !== 'string' || typeof payload.e !== 'number') {
    throw new DoubloonError('SIGNATURE_INVALID', 'Malformed session token payload');
  }

  const expiresAt = new Date(payload.e);

  if (expiresAt < new Date()) {
    throw new DoubloonError('SIGNATURE_INVALID', 'Session token has expired');
  }

  return { wallet: payload.w, expiresAt };
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

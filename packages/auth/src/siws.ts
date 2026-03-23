import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import { DoubloonError } from '@doubloon/core';

export interface SIWSConfig {
  domain: string;
  statement?: string;
  expirationMinutes?: number;
}

export function createSIWSMessage(
  config: SIWSConfig,
  walletAddress: string,
): { message: string; nonce: string } {
  const nonce = randomBytes(16).toString('hex');
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + (config.expirationMinutes ?? 10) * 60_000,
  ).toISOString();

  const message = [
    `${config.domain} wants you to sign in with your Solana account:`,
    walletAddress,
    '',
    config.statement ?? 'Sign in to Doubloon',
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join('\n');

  return { message, nonce };
}

export function verifySIWS(
  message: string,
  signature: Uint8Array,
  expectedNonce: string,
): { wallet: string; expiresAt: Date } {
  const lines = message.split('\n');
  const wallet = parseWalletFromLines(lines);
  const nonce = parseFieldFromLines(lines, 'Nonce');
  const expiresAtStr = parseFieldFromLines(lines, 'Expiration Time');

  if (nonce !== expectedNonce) {
    throw new DoubloonError('SIGNATURE_INVALID', 'Nonce mismatch');
  }

  const expiresAt = new Date(expiresAtStr);
  if (expiresAt < new Date()) {
    throw new DoubloonError('SIGNATURE_INVALID', 'Message has expired');
  }

  let publicKey: PublicKey;
  try {
    publicKey = new PublicKey(wallet);
  } catch {
    throw new DoubloonError('SIGNATURE_INVALID', 'Invalid wallet address in SIWS message');
  }
  const messageBytes = new TextEncoder().encode(message);
  const valid = nacl.sign.detached.verify(messageBytes, signature, publicKey.toBytes());
  if (!valid) {
    throw new DoubloonError('SIGNATURE_INVALID', 'Invalid signature');
  }

  return { wallet, expiresAt };
}

function parseWalletFromLines(lines: string[]): string {
  if (lines.length < 2) {
    throw new DoubloonError('SIGNATURE_INVALID', 'Malformed SIWS message');
  }
  return lines[1];
}

function parseFieldFromLines(lines: string[], field: string): string {
  const prefix = `${field}: `;
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      return line.substring(prefix.length);
    }
  }
  throw new DoubloonError('SIGNATURE_INVALID', `Missing ${field} in message`);
}

import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import { DoubloonError } from '@doubloon/core';

export interface SIWSConfig {
  domain: string;
  statement?: string;
  expirationMinutes?: number;
}

/**
 * Create a "Sign In With Solana" message for wallet authentication.
 * The message includes a unique nonce and expiration time.
 *
 * @param config - Configuration with domain, optional statement, and expiration minutes (default 10)
 * @param walletAddress - User's Solana wallet address (base58)
 * @returns Message text and nonce for the client to sign with the user's private key
 * @example
 * const { message, nonce } = createSIWSMessage(
 *   { domain: 'app.example.com' },
 *   'EPeUFDgscZpEKH4PvCXgxCumm2vpmWHHWiZiuyADcg47'
 * );
 * // Client signs message and returns signature + nonce
 */
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

const MAX_MESSAGE_LENGTH = 100_000; // 100 KB

/**
 * Verify a "Sign In With Solana" message and extract the wallet.
 * Validates the signature, checks nonce and expiration, and prevents replay attacks.
 *
 * @param message - The SIWS message text (newline-separated fields)
 * @param signature - The signature bytes (Ed25519 detached signature)
 * @param expectedNonce - The nonce that should be in the message (prevents replay)
 * @param expectedDomain - Optional domain for preventing cross-domain replay attacks
 * @returns Wallet address and expiration time
 * @throws DoubloonError if signature is invalid, message is expired, nonce doesn't match, or message is malformed
 * @example
 * const { wallet, expiresAt } = verifySIWS(message, signature, expectedNonce, 'app.example.com');
 * // wallet contains authenticated user's address
 */
export function verifySIWS(
  message: string,
  signature: Uint8Array,
  expectedNonce: string,
  expectedDomain?: string,
): { wallet: string; expiresAt: Date } {
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new DoubloonError('SIGNATURE_INVALID', `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`);
  }

  const lines = message.split('\n');
  const wallet = parseWalletFromLines(lines);
  const nonce = parseFieldFromLines(lines, 'Nonce');
  const expiresAtStr = parseFieldFromLines(lines, 'Expiration Time');

  // Verify domain to prevent cross-domain replay attacks
  if (expectedDomain) {
    const domainLine = lines[0];
    const expectedPrefix = `${expectedDomain} wants you to sign in with your Solana account:`;
    if (domainLine !== expectedPrefix) {
      throw new DoubloonError('SIGNATURE_INVALID', 'Domain mismatch in SIWS message');
    }
  }

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

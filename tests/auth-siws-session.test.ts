/**
 * E2E: SIWS authentication and session token flows.
 *
 * Tests createSIWSMessage, verifySIWS (domain binding, nonce, expiry,
 * malformed messages, invalid wallet), createSessionToken, verifySessionToken
 * (base64url round-trip, TTL, tampered tokens, malformed payloads).
 */
import { describe, it, expect, vi } from 'vitest';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import { createSIWSMessage, verifySIWS, createSessionToken, verifySessionToken } from '@doubloon/auth';
import { DoubloonError } from '@doubloon/core';

describe('SIWS: createSIWSMessage', () => {
  it('generates a valid SIWS message with all fields', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const { message, nonce } = createSIWSMessage(
      { domain: 'app.example.com', statement: 'Sign into My App' },
      wallet,
    );

    expect(nonce).toHaveLength(32); // 16 bytes = 32 hex chars
    expect(message).toContain('app.example.com wants you to sign in with your Solana account:');
    expect(message).toContain(wallet);
    expect(message).toContain('Sign into My App');
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain('Issued At:');
    expect(message).toContain('Expiration Time:');
  });

  it('uses default statement when none provided', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const { message } = createSIWSMessage({ domain: 'test.com' }, wallet);
    expect(message).toContain('Sign in to Doubloon');
  });

  it('custom expirationMinutes affects expiry', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const { message } = createSIWSMessage(
      { domain: 'test.com', expirationMinutes: 60 },
      wallet,
    );

    // Parse expiration from message
    const expiryLine = message.split('\n').find((l) => l.startsWith('Expiration Time:'));
    expect(expiryLine).toBeDefined();
    const expiry = new Date(expiryLine!.replace('Expiration Time: ', ''));
    // Should be ~60 minutes from now (allow 5s tolerance)
    const diff = expiry.getTime() - Date.now();
    expect(diff).toBeGreaterThan(59 * 60_000);
    expect(diff).toBeLessThan(61 * 60_000);
  });

  it('each call generates unique nonce', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const r1 = createSIWSMessage({ domain: 'd.com' }, wallet);
    const r2 = createSIWSMessage({ domain: 'd.com' }, wallet);
    expect(r1.nonce).not.toBe(r2.nonce);
  });
});

describe('SIWS: verifySIWS', () => {
  function signMessage(message: string, keypair: ReturnType<typeof Keypair.generate>): Uint8Array {
    const messageBytes = new TextEncoder().encode(message);
    return nacl.sign.detached(messageBytes, keypair.secretKey);
  }

  it('full round-trip: create → sign → verify', () => {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();
    const { message, nonce } = createSIWSMessage(
      { domain: 'app.example.com' },
      wallet,
    );

    const signature = signMessage(message, keypair);
    const result = verifySIWS(message, signature, nonce, 'app.example.com');

    expect(result.wallet).toBe(wallet);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects domain mismatch', () => {
    const keypair = Keypair.generate();
    const { message, nonce } = createSIWSMessage(
      { domain: 'app.example.com' },
      keypair.publicKey.toBase58(),
    );
    const signature = signMessage(message, keypair);

    expect(() => verifySIWS(message, signature, nonce, 'evil.com')).toThrow('Domain mismatch');
  });

  it('rejects nonce mismatch', () => {
    const keypair = Keypair.generate();
    const { message } = createSIWSMessage(
      { domain: 'd.com' },
      keypair.publicKey.toBase58(),
    );
    const signature = signMessage(message, keypair);

    expect(() => verifySIWS(message, signature, 'wrong-nonce', 'd.com')).toThrow('Nonce mismatch');
  });

  it('rejects expired message', () => {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();

    // Manually build an already-expired message
    const nonce = 'deadbeef'.repeat(4);
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const message = [
      `d.com wants you to sign in with your Solana account:`,
      wallet,
      '',
      'Sign in to Doubloon',
      '',
      `Nonce: ${nonce}`,
      `Issued At: ${new Date().toISOString()}`,
      `Expiration Time: ${pastExpiry}`,
    ].join('\n');

    const signature = signMessage(message, keypair);
    expect(() => verifySIWS(message, signature, nonce, 'd.com')).toThrow('expired');
  });

  it('rejects invalid signature', () => {
    const keypair = Keypair.generate();
    const { message, nonce } = createSIWSMessage(
      { domain: 'd.com' },
      keypair.publicKey.toBase58(),
    );

    // Sign with a different keypair
    const otherKeypair = Keypair.generate();
    const wrongSig = signMessage(message, otherKeypair);

    expect(() => verifySIWS(message, wrongSig, nonce, 'd.com')).toThrow('Invalid signature');
  });

  it('rejects malformed message (too short)', () => {
    const sig = new Uint8Array(64);
    expect(() => verifySIWS('single line', sig, 'n')).toThrow('Malformed SIWS message');
  });

  it('rejects message missing Nonce field', () => {
    const message = [
      'd.com wants you to sign in with your Solana account:',
      'SomeWallet123',
      '',
      'Statement',
      '',
      'Issued At: 2025-01-01T00:00:00Z',
      'Expiration Time: 2099-01-01T00:00:00Z',
    ].join('\n');

    expect(() => verifySIWS(message, new Uint8Array(64), 'n')).toThrow('Missing Nonce');
  });

  it('rejects message missing Expiration Time field', () => {
    const message = [
      'd.com wants you to sign in with your Solana account:',
      'SomeWallet123',
      '',
      'Statement',
      '',
      'Nonce: abc',
    ].join('\n');

    expect(() => verifySIWS(message, new Uint8Array(64), 'abc')).toThrow('Missing Expiration Time');
  });

  it('rejects invalid wallet address in message', () => {
    const keypair = Keypair.generate();
    const nonce = 'a'.repeat(32);
    const futureExpiry = new Date(Date.now() + 600_000).toISOString();

    const message = [
      'd.com wants you to sign in with your Solana account:',
      'not-a-valid-base58-pubkey!!!',
      '',
      'Sign in',
      '',
      `Nonce: ${nonce}`,
      `Issued At: ${new Date().toISOString()}`,
      `Expiration Time: ${futureExpiry}`,
    ].join('\n');

    const sig = signMessage(message, keypair);
    expect(() => verifySIWS(message, sig, nonce, 'd.com')).toThrow('Invalid wallet address');
  });

  it('works without expectedDomain (skips domain check)', () => {
    const keypair = Keypair.generate();
    const { message, nonce } = createSIWSMessage(
      { domain: 'any.domain.com' },
      keypair.publicKey.toBase58(),
    );
    const signature = signMessage(message, keypair);

    // No expectedDomain — should succeed
    const result = verifySIWS(message, signature, nonce);
    expect(result.wallet).toBe(keypair.publicKey.toBase58());
  });
});

describe('Session tokens', () => {
  const serverKeypair = nacl.sign.keyPair();

  it('full round-trip: create → verify', () => {
    const wallet = 'SomeWalletAddress123';
    const token = createSessionToken(wallet, serverKeypair.secretKey, 30);
    const result = verifySessionToken(token, serverKeypair.publicKey);

    expect(result.wallet).toBe(wallet);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + 31 * 60_000);
  });

  it('rejects expired token', async () => {
    const wallet = 'W1';
    // Create token with 0-minute TTL (already expired by the time we verify)
    const token = createSessionToken(wallet, serverKeypair.secretKey, 0);

    // Wait 1ms to ensure expiry
    await new Promise((r) => setTimeout(r, 5));
    expect(() => verifySessionToken(token, serverKeypair.publicKey)).toThrow('expired');
  });

  it('rejects tampered payload', () => {
    const token = createSessionToken('wallet', serverKeypair.secretKey, 30);
    const [payload, sig] = token.split('.');

    // Tamper with the payload by changing one character
    const tampered = payload.slice(0, -1) + (payload.slice(-1) === 'A' ? 'B' : 'A');
    const tamperedToken = `${tampered}.${sig}`;

    expect(() => verifySessionToken(tamperedToken, serverKeypair.publicKey)).toThrow('Invalid session token signature');
  });

  it('rejects wrong server public key', () => {
    const token = createSessionToken('wallet', serverKeypair.secretKey, 30);
    const otherKey = nacl.sign.keyPair().publicKey;

    expect(() => verifySessionToken(token, otherKey)).toThrow('Invalid session token signature');
  });

  it('rejects malformed token (no dot separator)', () => {
    expect(() => verifySessionToken('nodot', serverKeypair.publicKey)).toThrow('Malformed session token');
  });

  it('rejects token with 3 parts', () => {
    expect(() => verifySessionToken('a.b.c', serverKeypair.publicKey)).toThrow('Malformed session token');
  });

  it('base64url handles special characters', () => {
    // Wallet with characters that produce + and / in base64
    const wallet = '0xABCDEF1234567890+/=Special';
    const token = createSessionToken(wallet, serverKeypair.secretKey, 10);

    // Token should not contain + / or =
    expect(token).not.toMatch(/[+/=]/);

    const result = verifySessionToken(token, serverKeypair.publicKey);
    expect(result.wallet).toBe(wallet);
  });

  it('different TTL values produce different expiry times', () => {
    const t1 = createSessionToken('w', serverKeypair.secretKey, 5);
    const t2 = createSessionToken('w', serverKeypair.secretKey, 60);

    const r1 = verifySessionToken(t1, serverKeypair.publicKey);
    const r2 = verifySessionToken(t2, serverKeypair.publicKey);

    expect(r2.expiresAt.getTime()).toBeGreaterThan(r1.expiresAt.getTime());
    const diff = r2.expiresAt.getTime() - r1.expiresAt.getTime();
    expect(diff).toBeGreaterThan(54 * 60_000); // ~55 minute difference
  });
});

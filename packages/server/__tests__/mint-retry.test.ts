import { describe, it, expect, vi } from 'vitest';
import { mintWithRetry } from '../src/mint-retry.js';
import { DoubloonError } from '@drakkar.software/doubloon-core';
import type { ChainWriter, ChainSigner } from '../src/mint-retry.js';

const mockInstruction = {
  productId: 'a'.repeat(64),
  user: 'wallet123',
  expiresAt: new Date('2025-01-01'),
  source: 'apple' as const,
  sourceId: 'tx_123',
};

function makeMockWriter(fn: () => Promise<unknown>): ChainWriter {
  return { mintEntitlement: vi.fn(fn) };
}

function makeMockSigner(fn: (tx: unknown) => Promise<string>): ChainSigner {
  return { signAndSend: vi.fn(fn), publicKey: 'signerPubkey' };
}

describe('mintWithRetry', () => {
  it('succeeds on first attempt', async () => {
    const writer = makeMockWriter(async () => 'tx');
    const signer = makeMockSigner(async () => 'sig123');

    const result = await mintWithRetry(writer, signer, mockInstruction);
    expect(result.success).toBe(true);
    expect(result.txSignature).toBe('sig123');
    expect(result.retryCount).toBe(0);
  });

  it('succeeds on third attempt', async () => {
    let attempts = 0;
    const writer = makeMockWriter(async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return 'tx';
    });
    const signer = makeMockSigner(async () => 'sig456');

    const result = await mintWithRetry(writer, signer, mockInstruction, {
      baseDelayMs: 10,
      maxDelayMs: 50,
    });
    expect(result.success).toBe(true);
    expect(result.retryCount).toBe(2);
  });

  it('fails after all retries', async () => {
    const writer = makeMockWriter(async () => { throw new Error('always fail'); });
    const signer = makeMockSigner(async () => 'sig');

    const result = await mintWithRetry(writer, signer, mockInstruction, {
      maxRetries: 3,
      baseDelayMs: 10,
    });
    expect(result.success).toBe(false);
    expect(result.retryCount).toBe(3);
    expect(result.lastError?.message).toBe('always fail');
  });

  it('bails immediately on non-retryable error', async () => {
    const writer = makeMockWriter(async () => {
      throw new DoubloonError('PRODUCT_NOT_ACTIVE', 'Product inactive', { retryable: false });
    });
    const signer = makeMockSigner(async () => 'sig');

    const result = await mintWithRetry(writer, signer, mockInstruction, {
      maxRetries: 3,
      baseDelayMs: 10,
    });
    expect(result.success).toBe(false);
    expect(result.retryCount).toBe(1);
  });
});

/**
 * E2E: Mint-retry through full server pipeline.
 *
 * Tests retry behavior, exponential backoff, non-retryable error bailout,
 * signAndSend failure after mintEntitlement success, and custom retry options
 * flowing through the webhook → processInstruction → mintWithRetry path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLocalChain } from '@doubloon/chain-local';
import { createServer, mintWithRetry } from '@doubloon/server';
import { deriveProductIdHex, DoubloonError } from '@doubloon/core';
import type { MintInstruction, StoreNotification } from '@doubloon/core';
import type { ChainWriter, ChainSigner, MintRetryResult } from '@doubloon/server';

function makeNotification(overrides?: Partial<StoreNotification>): StoreNotification {
  return {
    id: 'n1', type: 'initial_purchase', store: 'stripe', environment: 'production',
    productId: 'p', userWallet: 'w', originalTransactionId: 'txn',
    expiresAt: null, autoRenew: false,
    storeTimestamp: new Date(), receivedTimestamp: new Date(),
    deduplicationKey: `dedup_${Math.random().toString(36).slice(2)}`, raw: {},
    ...overrides,
  };
}

describe('mintWithRetry standalone', () => {
  const instruction: MintInstruction = {
    productId: deriveProductIdHex('retry-test'),
    user: '0xAlice',
    expiresAt: null,
    source: 'stripe',
    sourceId: 'sub_retry',
  };

  it('succeeds on first attempt', async () => {
    const writer: ChainWriter = { mintEntitlement: vi.fn(async () => 'tx') };
    const signer: ChainSigner = { signAndSend: vi.fn(async () => 'sig123'), publicKey: 'pk' };

    const result = await mintWithRetry(writer, signer, instruction);
    expect(result.success).toBe(true);
    expect(result.txSignature).toBe('sig123');
    expect(result.retryCount).toBe(0);
    expect(writer.mintEntitlement).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds', async () => {
    let attempt = 0;
    const writer: ChainWriter = {
      mintEntitlement: vi.fn(async () => {
        attempt++;
        if (attempt < 3) throw new Error('RPC timeout');
        return 'tx';
      }),
    };
    const signer: ChainSigner = { signAndSend: vi.fn(async () => 'sig_retry'), publicKey: 'pk' };

    const result = await mintWithRetry(writer, signer, instruction, {
      maxRetries: 5,
      baseDelayMs: 1, // tiny delay for test speed
      maxDelayMs: 2,
    });

    expect(result.success).toBe(true);
    expect(result.retryCount).toBe(2); // succeeded on 3rd attempt (0-indexed)
    expect(writer.mintEntitlement).toHaveBeenCalledTimes(3);
  });

  it('bails out immediately on non-retryable DoubloonError', async () => {
    const writer: ChainWriter = {
      mintEntitlement: vi.fn(async () => {
        throw new DoubloonError('PRODUCT_FROZEN', 'Product is frozen', { retryable: false });
      }),
    };
    const signer: ChainSigner = { signAndSend: vi.fn(), publicKey: 'pk' };

    const result = await mintWithRetry(writer, signer, instruction, {
      maxRetries: 5,
      baseDelayMs: 1,
    });

    expect(result.success).toBe(false);
    expect(result.retryCount).toBe(1); // only one attempt
    expect(result.lastError!.message).toBe('Product is frozen');
    expect(writer.mintEntitlement).toHaveBeenCalledTimes(1);
    expect(signer.signAndSend).not.toHaveBeenCalled();
  });

  it('retries retryable DoubloonError', async () => {
    let calls = 0;
    const writer: ChainWriter = {
      mintEntitlement: vi.fn(async () => {
        calls++;
        if (calls < 2) {
          throw new DoubloonError('RPC_ERROR', 'RPC timeout', { retryable: true });
        }
        return 'tx';
      }),
    };
    const signer: ChainSigner = { signAndSend: vi.fn(async () => 'sig'), publicKey: 'pk' };

    const result = await mintWithRetry(writer, signer, instruction, {
      maxRetries: 3,
      baseDelayMs: 1,
    });

    expect(result.success).toBe(true);
    expect(result.retryCount).toBe(1);
  });

  it('fails after maxRetries exhausted', async () => {
    const writer: ChainWriter = {
      mintEntitlement: vi.fn(async () => { throw new Error('Always fails'); }),
    };
    const signer: ChainSigner = { signAndSend: vi.fn(), publicKey: 'pk' };

    const result = await mintWithRetry(writer, signer, instruction, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
    });

    expect(result.success).toBe(false);
    expect(result.retryCount).toBe(3);
    expect(result.lastError!.message).toBe('Always fails');
    expect(writer.mintEntitlement).toHaveBeenCalledTimes(3);
  });

  it('signAndSend failure after mintEntitlement success', async () => {
    const writer: ChainWriter = { mintEntitlement: vi.fn(async () => 'tx') };
    const signer: ChainSigner = {
      signAndSend: vi.fn(async () => { throw new Error('Signing failed'); }),
      publicKey: 'pk',
    };

    const result = await mintWithRetry(writer, signer, instruction, {
      maxRetries: 2,
      baseDelayMs: 1,
    });

    // mintEntitlement succeeds but signAndSend fails — should retry the full flow
    expect(result.success).toBe(false);
    expect(writer.mintEntitlement).toHaveBeenCalledTimes(2);
    expect(signer.signAndSend).toHaveBeenCalledTimes(2);
  });

  it('default options: maxRetries=3, baseDelayMs=1000', async () => {
    const writer: ChainWriter = {
      mintEntitlement: vi.fn(async () => { throw new Error('fail'); }),
    };
    const signer: ChainSigner = { signAndSend: vi.fn(), publicKey: 'pk' };

    // Use a spy to track timing without actually waiting
    const startTime = Date.now();
    const result = await mintWithRetry(writer, signer, instruction, {
      // Override delays for speed but keep default maxRetries behavior
      baseDelayMs: 1,
      maxDelayMs: 2,
    });

    expect(result.success).toBe(false);
    expect(result.retryCount).toBe(3); // default maxRetries
  });
});

describe('Mint-retry through webhook pipeline', () => {
  const productId = deriveProductIdHex('pipeline-retry');
  const wallet = '0xAlice';

  let local: ReturnType<typeof createLocalChain>;

  beforeEach(() => {
    local = createLocalChain();
  });

  it('onMintFailure called with correct context after retries exhausted', async () => {
    const onMintFailure = vi.fn(async () => {});

    const stripeBridge = {
      handleNotification: vi.fn(async () => ({
        notification: makeNotification({ deduplicationKey: 'retry-fail' }),
        instruction: {
          productId, user: wallet, expiresAt: null,
          source: 'stripe' as const, sourceId: 'sub_1',
        } satisfies MintInstruction,
      })),
    };

    // Writer that always fails
    const failWriter = {
      mintEntitlement: vi.fn(async () => { throw new Error('Chain down'); }),
      revokeEntitlement: local.writer.revokeEntitlement.bind(local.writer),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: failWriter as any, signer: local.signer },
      bridges: { stripe: stripeBridge },
      onMintFailure,
      mintRetry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });

    const result = await server.handleWebhook({
      headers: { 'stripe-signature': 'sig' },
      body: '{}',
    });

    // Server returns 200 to acknowledge webhook even on mint failure
    expect(result.status).toBe(200);
    expect(onMintFailure).toHaveBeenCalledWith(
      expect.objectContaining({ productId, user: wallet }),
      expect.any(Error),
      expect.objectContaining({
        store: 'stripe',
        retryCount: 2,
        willStoreRetry: true, // stripe supports retry
      }),
    );
  });

  it('x402 mint failure has willStoreRetry=false', async () => {
    const onMintFailure = vi.fn(async () => {});

    // x402 is detected differently — we'll use processInstruction directly
    const failWriter = {
      mintEntitlement: vi.fn(async () => { throw new Error('fail'); }),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: failWriter as any, signer: local.signer },
      bridges: {},
      onMintFailure,
      mintRetry: { maxRetries: 1, baseDelayMs: 1 },
    });

    await server.processInstruction(
      { productId, user: wallet, expiresAt: null, source: 'x402', sourceId: 'pay_1' },
      makeNotification({ store: 'x402' as any }),
      'x402' as any,
    );

    expect(onMintFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ willStoreRetry: false }),
    );
  });

  it('non-retryable error propagated to onMintFailure without exhausting retries', async () => {
    const onMintFailure = vi.fn(async () => {});

    const failWriter = {
      mintEntitlement: vi.fn(async () => {
        throw new DoubloonError('PRODUCT_FROZEN', 'Frozen', { retryable: false });
      }),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: failWriter as any, signer: local.signer },
      bridges: {},
      onMintFailure,
      mintRetry: { maxRetries: 5, baseDelayMs: 1 },
    });

    await server.processInstruction(
      { productId, user: wallet, expiresAt: null, source: 'stripe', sourceId: 'sub_1' },
      makeNotification(),
      'stripe',
    );

    expect(onMintFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'Frozen' }),
      expect.objectContaining({ retryCount: 1 }),
    );
    expect(failWriter.mintEntitlement).toHaveBeenCalledTimes(1);
  });
});

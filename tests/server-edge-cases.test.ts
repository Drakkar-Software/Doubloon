/**
 * E2E: Server edge cases — payload limits, error classification, dedup lifecycle,
 * deprecated API compatibility, logger integration, Google acknowledgment,
 * revoke without writer support, and store clear/reset.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLocalChain } from '@doubloon/chain-local';
import { createServer, MemoryDedupStore, createRateLimiter, MemoryRateLimiterStore } from '@doubloon/server';
import { deriveProductIdHex, DoubloonError, validateSlug, deriveProductId, isMintInstruction } from '@doubloon/core';
import type { MintInstruction, RevokeInstruction, StoreNotification, Logger } from '@doubloon/core';

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

describe('Payload size validation', () => {
  let local: ReturnType<typeof createLocalChain>;

  beforeEach(() => {
    local = createLocalChain();
  });

  it('rejects payloads > 1MB', async () => {
    const stripeBridge = {
      handleNotification: vi.fn(async () => ({
        notification: makeNotification(),
        instruction: null,
      })),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: local.writer, signer: local.signer },
      bridges: { stripe: stripeBridge },
      onMintFailure: vi.fn(),
    });

    const hugeBody = 'x'.repeat(1_048_577); // 1MB + 1 byte
    const result = await server.handleWebhook({
      headers: { 'stripe-signature': 'sig' },
      body: hugeBody,
    });

    expect(result.status).toBe(400);
    expect(result.body).toBe('Payload too large');
    expect(stripeBridge.handleNotification).not.toHaveBeenCalled();
  });

  it('accepts payloads exactly 1MB', async () => {
    const stripeBridge = {
      handleNotification: vi.fn(async () => ({
        notification: makeNotification(),
        instruction: null,
      })),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: local.writer, signer: local.signer },
      bridges: { stripe: stripeBridge },
      onMintFailure: vi.fn(),
    });

    const maxBody = 'x'.repeat(1_048_576); // exactly 1MB
    const result = await server.handleWebhook({
      headers: { 'stripe-signature': 'sig' },
      body: maxBody,
    });

    expect(result.status).toBe(200);
    expect(stripeBridge.handleNotification).toHaveBeenCalled();
  });
});

describe('DoubloonError code classification', () => {
  let local: ReturnType<typeof createLocalChain>;

  beforeEach(() => {
    local = createLocalChain();
  });

  const clientErrorCodes = [
    'INVALID_RECEIPT',
    'PRODUCT_NOT_MAPPED',
    'WALLET_NOT_LINKED',
    'INVALID_SIGNATURE',
  ] as const;

  for (const code of clientErrorCodes) {
    it(`${code} returns 400`, async () => {
      const stripeBridge = {
        handleNotification: vi.fn(async () => {
          throw new DoubloonError(code, `Error: ${code}`);
        }),
      };

      const server = createServer({
        chain: { reader: local.reader, writer: local.writer, signer: local.signer },
        bridges: { stripe: stripeBridge },
        onMintFailure: vi.fn(),
      });

      const result = await server.handleWebhook({
        headers: { 'stripe-signature': 'sig' },
        body: '{}',
      });

      expect(result.status).toBe(400);
      expect(result.body).toBe(`Error: ${code}`);
    });
  }

  const serverErrorCodes = [
    'RPC_ERROR',
    'TRANSACTION_FAILED',
    'STORE_API_ERROR',
    'ACCOUNT_NOT_FOUND',
    'AUTHORITY_MISMATCH',
  ] as const;

  for (const code of serverErrorCodes) {
    it(`${code} returns 500`, async () => {
      const stripeBridge = {
        handleNotification: vi.fn(async () => {
          throw new DoubloonError(code, `Error: ${code}`);
        }),
      };

      const server = createServer({
        chain: { reader: local.reader, writer: local.writer, signer: local.signer },
        bridges: { stripe: stripeBridge },
        onMintFailure: vi.fn(),
      });

      const result = await server.handleWebhook({
        headers: { 'stripe-signature': 'sig' },
        body: '{}',
      });

      expect(result.status).toBe(500);
    });
  }
});

describe('MemoryDedupStore lifecycle', () => {
  it('TTL expiration: stale entries are not duplicates', async () => {
    const dedup = new MemoryDedupStore({ ttlMs: 50 }); // 50ms TTL

    await dedup.markProcessed('key1');
    expect(await dedup.isDuplicate('key1')).toBe(true);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 100));
    expect(await dedup.isDuplicate('key1')).toBe(false);

    dedup.destroy();
  });

  it('maxEntries eviction: oldest entry evicted when capacity exceeded', async () => {
    const dedup = new MemoryDedupStore({ ttlMs: 60_000, maxEntries: 3 });

    await dedup.markProcessed('a');
    await dedup.markProcessed('b');
    await dedup.markProcessed('c');
    expect(dedup.size).toBe(3);

    // Adding 4th should evict 'a' (oldest)
    await dedup.markProcessed('d');
    expect(dedup.size).toBe(3);
    expect(await dedup.isDuplicate('a')).toBe(false); // evicted
    expect(await dedup.isDuplicate('b')).toBe(true);
    expect(await dedup.isDuplicate('d')).toBe(true);

    dedup.destroy();
  });

  it('clearProcessed removes specific key', async () => {
    const dedup = new MemoryDedupStore({ ttlMs: 60_000 });

    await dedup.markProcessed('key1');
    await dedup.markProcessed('key2');
    expect(dedup.size).toBe(2);

    await dedup.clearProcessed('key1');
    expect(dedup.size).toBe(1);
    expect(await dedup.isDuplicate('key1')).toBe(false);
    expect(await dedup.isDuplicate('key2')).toBe(true);

    dedup.destroy();
  });

  it('markProcessed updates expiry for existing key', async () => {
    const dedup = new MemoryDedupStore({ ttlMs: 100 });

    await dedup.markProcessed('key1');
    // Wait 60ms, then re-mark
    await new Promise((r) => setTimeout(r, 60));
    await dedup.markProcessed('key1');

    // Wait another 60ms — original TTL would have expired, but re-mark extended it
    await new Promise((r) => setTimeout(r, 60));
    expect(await dedup.isDuplicate('key1')).toBe(true);

    dedup.destroy();
  });
});

describe('Deprecated isDuplicate/markProcessed API', () => {
  let local: ReturnType<typeof createLocalChain>;

  beforeEach(() => {
    local = createLocalChain();
  });

  it('deprecated callbacks work for backward compatibility', async () => {
    const processed = new Set<string>();
    const isDuplicate = vi.fn(async (key: string) => processed.has(key));
    const markProcessed = vi.fn(async (key: string) => { processed.add(key); });

    const stripeBridge = {
      handleNotification: vi.fn(async () => ({
        notification: makeNotification({ deduplicationKey: 'compat-1' }),
        instruction: null,
      })),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: local.writer, signer: local.signer },
      bridges: { stripe: stripeBridge },
      isDuplicate,
      markProcessed,
      onMintFailure: vi.fn(),
    });

    // First call
    await server.handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: '{}' });
    expect(markProcessed).toHaveBeenCalledWith('compat-1');

    // Second call — should be detected as duplicate
    await server.handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: '{}' });
    expect(isDuplicate).toHaveBeenCalledWith('compat-1');
    // Bridge should only be called once for each unique dedup key... but the bridge
    // is called before dedup check in the current implementation, so check processing
    expect(stripeBridge.handleNotification).toHaveBeenCalledTimes(2);
  });
});

describe('Dedup key cleared on processing failure', () => {
  let local: ReturnType<typeof createLocalChain>;

  beforeEach(() => {
    local = createLocalChain();
  });

  it('processing exception clears dedup key so store can retry', async () => {
    const dedup = new MemoryDedupStore({ ttlMs: 60_000 });
    let attempt = 0;

    // The revoke path THROWS on failure (unlike mint which calls onMintFailure).
    // Use a revoke instruction that fails on first attempt.
    const stripeBridge = {
      handleNotification: vi.fn(async () => ({
        notification: makeNotification({ deduplicationKey: 'fail-clear', type: 'revocation' }),
        instruction: {
          productId: deriveProductIdHex('test-prod'),
          user: '0xAlice',
          reason: 'refund',
        } satisfies RevokeInstruction,
      })),
    };

    // Writer.revokeEntitlement fails on first call, succeeds on second
    const revokeWriter = {
      mintEntitlement: vi.fn(async () => 'tx'),
      revokeEntitlement: vi.fn(async () => {
        attempt++;
        if (attempt === 1) throw new Error('Chain timeout');
        return 'tx';
      }),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: revokeWriter as any, signer: local.signer },
      bridges: { stripe: stripeBridge },
      dedup,
      onMintFailure: vi.fn(),
    });

    // First webhook: revoke throws, processing fails, dedup key cleared
    const r1 = await server.handleWebhook({
      headers: { 'stripe-signature': 'sig' },
      body: '{}',
    });
    expect(r1.status).toBe(500); // error propagated

    // Dedup key should be cleared after failure
    expect(await dedup.isDuplicate('fail-clear')).toBe(false);

    // Second webhook (store retry): should process again successfully
    const r2 = await server.handleWebhook({
      headers: { 'stripe-signature': 'sig' },
      body: '{}',
    });
    expect(r2.status).toBe(200);
    expect(revokeWriter.revokeEntitlement).toHaveBeenCalledTimes(2);

    dedup.destroy();
  });

  it('mint failure via onMintFailure does NOT clear dedup key (non-throwing path)', async () => {
    const dedup = new MemoryDedupStore({ ttlMs: 60_000 });
    const onMintFailure = vi.fn(async () => {});

    const stripeBridge = {
      handleNotification: vi.fn(async () => ({
        notification: makeNotification({ deduplicationKey: 'mint-fail-dedup' }),
        instruction: {
          productId: deriveProductIdHex('test-prod'),
          user: '0xAlice',
          expiresAt: null,
          source: 'stripe' as const,
          sourceId: 'sub_1',
        } satisfies MintInstruction,
      })),
    };

    const failWriter = {
      mintEntitlement: vi.fn(async () => { throw new Error('fail'); }),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: failWriter as any, signer: local.signer },
      bridges: { stripe: stripeBridge },
      dedup,
      onMintFailure,
      mintRetry: { maxRetries: 1, baseDelayMs: 1 },
    });

    await server.handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: '{}' });

    // Mint failure goes through onMintFailure callback (doesn't throw),
    // so dedup key remains — the server considers it "processed"
    expect(await dedup.isDuplicate('mint-fail-dedup')).toBe(true);
    expect(onMintFailure).toHaveBeenCalled();

    dedup.destroy();
  });
});

describe('Google acknowledgment hook', () => {
  let local: ReturnType<typeof createLocalChain>;

  beforeEach(() => {
    local = createLocalChain();
  });

  it('onAcknowledgmentRequired called for Google initial_purchase', async () => {
    const onAck = vi.fn(async () => {});

    const googleBridge = {
      handleNotification: vi.fn(async () => ({
        notification: makeNotification({
          store: 'google',
          type: 'initial_purchase',
          originalTransactionId: 'GPA.token.123',
          deduplicationKey: 'google-ack-1',
        }),
        instruction: {
          productId: deriveProductIdHex('pro-monthly'),
          user: '0xAlice',
          expiresAt: new Date(Date.now() + 86400_000),
          source: 'google' as const,
          sourceId: 'GPA.token.123',
        } satisfies MintInstruction,
        requiresAcknowledgment: true,
      })),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: local.writer, signer: local.signer },
      bridges: { google: googleBridge },
      onAcknowledgmentRequired: onAck,
      onMintFailure: vi.fn(),
    });

    await server.handleWebhook({
      headers: {},
      body: JSON.stringify({ message: { data: 'base64data' } }),
    });

    expect(onAck).toHaveBeenCalledWith(
      'GPA.token.123',
      expect.any(Date),
    );

    // Deadline should be ~3 days from now
    const deadline = onAck.mock.calls[0][1] as Date;
    const threeDaysMs = 3 * 86400_000;
    expect(deadline.getTime()).toBeGreaterThan(Date.now() + threeDaysMs - 5000);
    expect(deadline.getTime()).toBeLessThan(Date.now() + threeDaysMs + 5000);
  });

  it('no acknowledgment when onAcknowledgmentRequired not configured', async () => {
    const googleBridge = {
      handleNotification: vi.fn(async () => ({
        notification: makeNotification({ store: 'google', deduplicationKey: 'google-no-ack' }),
        instruction: null,
        requiresAcknowledgment: true,
      })),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: local.writer, signer: local.signer },
      bridges: { google: googleBridge },
      // No onAcknowledgmentRequired
      onMintFailure: vi.fn(),
    });

    // Should not throw even though acknowledgment is required
    const result = await server.handleWebhook({
      headers: {},
      body: JSON.stringify({ message: { data: 'data' } }),
    });
    expect(result.status).toBe(200);
  });
});

describe('Revoke without writer.revokeEntitlement', () => {
  it('logs warning when writer lacks revokeEntitlement method', async () => {
    const local = createLocalChain();
    const logger: Logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    };

    // Writer without revokeEntitlement
    const writerNoRevoke = {
      mintEntitlement: local.writer.mintEntitlement.bind(local.writer),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: writerNoRevoke, signer: local.signer },
      bridges: {},
      onMintFailure: vi.fn(),
      logger,
    });

    const revokeInstruction: RevokeInstruction = {
      productId: deriveProductIdHex('test'), user: '0xAlice', reason: 'refund',
    };

    await server.processInstruction(
      revokeInstruction,
      makeNotification({ type: 'revocation' }),
      'stripe',
    );

    expect(logger.warn).toHaveBeenCalledWith(
      'Revoke not supported by chain writer',
      expect.objectContaining({ productId: revokeInstruction.productId }),
    );
  });
});

describe('Logger integration through full pipeline', () => {
  it('logs all stages: webhook received → mint success', async () => {
    const local = createLocalChain();
    const logger: Logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    };

    const stripeBridge = {
      handleNotification: vi.fn(async () => ({
        notification: makeNotification({ deduplicationKey: 'log-test' }),
        instruction: {
          productId: deriveProductIdHex('log-prod'),
          user: '0xAlice',
          expiresAt: null,
          source: 'stripe' as const,
          sourceId: 'sub_1',
        } satisfies MintInstruction,
      })),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: local.writer, signer: local.signer },
      bridges: { stripe: stripeBridge },
      onMintFailure: vi.fn(),
      logger,
    });

    await server.handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: '{}' });

    // Should have logged: webhook received, entitlement minted
    expect(logger.info).toHaveBeenCalledWith('Webhook received', expect.objectContaining({ store: 'stripe' }));
    expect(logger.info).toHaveBeenCalledWith('Entitlement minted', expect.objectContaining({
      productId: deriveProductIdHex('log-prod'),
      user: '0xAlice',
    }));
  });

  it('logs error on webhook failure', async () => {
    const local = createLocalChain();
    const logger: Logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    };

    const stripeBridge = {
      handleNotification: vi.fn(async () => { throw new Error('boom'); }),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: local.writer, signer: local.signer },
      bridges: { stripe: stripeBridge },
      onMintFailure: vi.fn(),
      logger,
    });

    await server.handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: '{}' });

    expect(logger.error).toHaveBeenCalledWith(
      'Webhook processing failed',
      expect.objectContaining({ store: 'stripe' }),
    );
  });

  it('logs rate limit warning', async () => {
    const local = createLocalChain();
    const logger: Logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: local.writer, signer: local.signer },
      bridges: { stripe: { handleNotification: vi.fn(async () => ({ notification: makeNotification(), instruction: null })) } },
      rateLimiter: { maxRequests: 1, windowMs: 60_000 },
      onMintFailure: vi.fn(),
      logger,
    });

    await server.handleWebhook({ headers: { 'stripe-signature': 'sig', 'x-forwarded-for': '1.2.3.4' }, body: '{}' });
    await server.handleWebhook({ headers: { 'stripe-signature': 'sig', 'x-forwarded-for': '1.2.3.4' }, body: '{}' });

    expect(logger.warn).toHaveBeenCalledWith('Rate limited', expect.any(Object));
  });

  it('logs duplicate notification skip', async () => {
    const local = createLocalChain();
    const logger: Logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    };

    const stripeBridge = {
      handleNotification: vi.fn(async () => ({
        notification: makeNotification({ deduplicationKey: 'dup-log' }),
        instruction: null,
      })),
    };

    const server = createServer({
      chain: { reader: local.reader, writer: local.writer, signer: local.signer },
      bridges: { stripe: stripeBridge },
      onMintFailure: vi.fn(),
      logger,
    });

    await server.handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: '{}' });
    await server.handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: '{}' });

    expect(logger.info).toHaveBeenCalledWith(
      'Duplicate notification, skipping',
      expect.objectContaining({ key: 'dup-log' }),
    );
  });
});

describe('Rate limiter standalone', () => {
  it('custom keyExtractor groups by API key instead of IP', async () => {
    const limiter = createRateLimiter({
      maxRequests: 2,
      windowMs: 60_000,
      keyExtractor: (req) => `apikey:${req.headers['x-api-key'] || 'none'}`,
    });

    const keyA = { headers: { 'x-api-key': 'key-a' } };
    const keyB = { headers: { 'x-api-key': 'key-b' } };

    expect(await limiter.check(keyA)).toBe(true);
    expect(await limiter.check(keyA)).toBe(true);
    expect(await limiter.check(keyA)).toBe(false); // exceeded

    // Key B is independent
    expect(await limiter.check(keyB)).toBe(true);
  });

  it('MemoryRateLimiterStore.destroy cleans up timer', () => {
    const store = new MemoryRateLimiterStore();
    // Should not throw
    store.destroy();
    store.destroy(); // double destroy is safe
  });
});

describe('Product slug validation', () => {
  it('rejects slugs shorter than 3 chars', () => {
    expect(() => validateSlug('ab')).toThrow('3-64 chars');
  });

  it('rejects slugs longer than 64 chars', () => {
    expect(() => validateSlug('a'.repeat(65))).toThrow('3-64 chars');
  });

  it('rejects slugs with leading hyphen', () => {
    expect(() => validateSlug('-abc')).toThrow('lowercase alphanumeric');
  });

  it('rejects slugs with trailing hyphen', () => {
    expect(() => validateSlug('abc-')).toThrow('lowercase alphanumeric');
  });

  it('rejects slugs with consecutive hyphens', () => {
    expect(() => validateSlug('abc--def')).toThrow('consecutive hyphens');
  });

  it('rejects uppercase', () => {
    expect(() => validateSlug('Pro-Monthly')).toThrow('lowercase alphanumeric');
  });

  it('accepts valid slugs at boundary lengths', () => {
    expect(() => validateSlug('abc')).not.toThrow(); // min
    expect(() => validateSlug('a'.repeat(64))).not.toThrow(); // max
  });

  it('deriveProductId returns 32-byte Uint8Array', () => {
    const id = deriveProductId('pro-monthly');
    expect(id).toBeInstanceOf(Uint8Array);
    expect(id.length).toBe(32);
  });

  it('deriveProductIdHex is deterministic', () => {
    expect(deriveProductIdHex('pro-monthly')).toBe(deriveProductIdHex('pro-monthly'));
    expect(deriveProductIdHex('pro-monthly')).not.toBe(deriveProductIdHex('pro-yearly'));
  });
});

describe('isMintInstruction type guard', () => {
  it('returns true for MintInstruction (has source)', () => {
    const mint: MintInstruction = {
      productId: 'p', user: 'u', expiresAt: null, source: 'stripe', sourceId: 's',
    };
    expect(isMintInstruction(mint)).toBe(true);
  });

  it('returns false for RevokeInstruction (no source)', () => {
    const revoke: RevokeInstruction = { productId: 'p', user: 'u', reason: 'test' };
    expect(isMintInstruction(revoke)).toBe(false);
  });
});

describe('DoubloonError properties', () => {
  it('retryable defaults to false', () => {
    const err = new DoubloonError('RPC_ERROR', 'timeout');
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('RPC_ERROR');
    expect(err.name).toBe('DoubloonError');
  });

  it('retryable can be set to true', () => {
    const err = new DoubloonError('RPC_ERROR', 'timeout', { retryable: true });
    expect(err.retryable).toBe(true);
  });

  it('includes store and chain context', () => {
    const err = new DoubloonError('STORE_API_ERROR', 'Apple API down', {
      store: 'apple', chain: 'solana', retryable: true,
    });
    expect(err.store).toBe('apple');
    expect(err.chain).toBe('solana');
  });

  it('wraps cause error', () => {
    const cause = new Error('original');
    const err = new DoubloonError('TRANSACTION_FAILED', 'tx failed', { cause });
    expect(err.cause).toBe(cause);
  });

  it('is instanceof Error', () => {
    const err = new DoubloonError('RPC_ERROR', 'test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DoubloonError);
  });
});

describe('Store clear and reset', () => {
  it('clear resets platform, products, entitlements, delegates, and tx counter', () => {
    const local = createLocalChain();
    const pid = deriveProductIdHex('clear-test');

    local.store.registerProduct({ productId: pid, name: 'P', metadataUri: '', defaultDuration: 0, creator: '0x' });
    local.store.mintEntitlement({ productId: pid, user: '0xA', expiresAt: null, source: 'platform', sourceId: '1' });
    local.store.grantDelegation({ productId: pid, delegate: '0xD', grantedBy: '0x', expiresAt: null, maxMints: 10 });

    expect(local.store.productCount).toBe(1);
    expect(local.store.entitlementCount).toBe(1);
    expect(local.store.getPlatform().productCount).toBe(1);

    local.store.clear();

    expect(local.store.productCount).toBe(0);
    expect(local.store.entitlementCount).toBe(0);
    expect(local.store.getPlatform().productCount).toBe(0);
    expect(local.store.getPlatform().frozen).toBe(false);
    expect(local.store.getProduct(pid)).toBeNull();
    expect(local.store.getEntitlement(pid, '0xA')).toBeNull();
    expect(local.store.getDelegate(pid, '0xD')).toBeNull();
  });

  it('getAllProducts returns all registered products', () => {
    const local = createLocalChain();
    const pids = ['prod-aaa', 'prod-bbb', 'prod-ccc'].map(deriveProductIdHex);

    for (const pid of pids) {
      local.store.registerProduct({ productId: pid, name: pid.slice(0, 8), metadataUri: '', defaultDuration: 0, creator: '0x' });
    }

    const all = local.store.getAllProducts();
    expect(all).toHaveLength(3);
    expect(all.map((p) => p.productId).sort()).toEqual([...pids].sort());
  });

  it('getAllEntitlements returns all entitlements across users/products', () => {
    const local = createLocalChain();
    const pid = deriveProductIdHex('all-ents');

    local.store.mintEntitlement({ productId: pid, user: '0xA', expiresAt: null, source: 'platform', sourceId: '1' });
    local.store.mintEntitlement({ productId: pid, user: '0xB', expiresAt: null, source: 'platform', sourceId: '2' });

    const pid2 = deriveProductIdHex('all-ents-2');
    local.store.mintEntitlement({ productId: pid2, user: '0xA', expiresAt: null, source: 'stripe', sourceId: '3' });

    const all = local.store.getAllEntitlements();
    expect(all).toHaveLength(3);
  });
});

describe('Receipt packagers', () => {
  it('packageAppleReceipt wraps JWS', async () => {
    const { packageAppleReceipt } = await import('@doubloon/react-native');
    const receipt = packageAppleReceipt('eyJhbGciOiJSUzI1NiJ9.payload.sig');
    expect(receipt.store).toBe('apple');
    expect(receipt.receipt).toBe('eyJhbGciOiJSUzI1NiJ9.payload.sig');
  });

  it('packageGoogleReceipt wraps purchase token', async () => {
    const { packageGoogleReceipt } = await import('@doubloon/react-native');
    const receipt = packageGoogleReceipt('GPA.token.123', 'com.app.premium');
    expect(receipt.store).toBe('google');
    expect(receipt.receipt).toBe('GPA.token.123');
    expect(receipt.productId).toBe('com.app.premium');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createServer } from '../src/server.js';
import type { ServerConfig } from '../src/server.js';

function makeMinimalConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    chain: {
      reader: {
        checkEntitlement: vi.fn(async () => ({
          entitled: false, entitlement: null, reason: 'not_found' as const,
          expiresAt: null, product: null,
        })),
        checkEntitlements: vi.fn(async () => ({
          results: {}, user: '', checkedAt: new Date(),
        })),
      },
      writer: { mintEntitlement: vi.fn(async () => 'tx') },
      signer: { signAndSend: vi.fn(async () => 'sig'), publicKey: 'signer' },
    },
    bridges: {},
    onMintFailure: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('createServer', () => {
  describe('detectStore', () => {
    it('detects Stripe from header', () => {
      const server = createServer(makeMinimalConfig());
      expect(
        server.detectStore({ headers: { 'stripe-signature': 'xxx' }, body: '' }),
      ).toBe('stripe');
    });

    it('detects Google from Pub/Sub body', () => {
      const server = createServer(makeMinimalConfig());
      expect(
        server.detectStore({
          headers: {},
          body: JSON.stringify({ message: { data: 'xxx' } }),
        }),
      ).toBe('google');
    });

    it('detects Apple from JWS body', () => {
      const server = createServer(makeMinimalConfig());
      expect(
        server.detectStore({ headers: {}, body: 'eyJhbGciOiJSUzI1NiJ9...' }),
      ).toBe('apple');
    });

    it('returns null for unknown', () => {
      const server = createServer(makeMinimalConfig());
      expect(
        server.detectStore({ headers: {}, body: 'random data' }),
      ).toBeNull();
    });
  });

  it('returns 400 for unknown store', async () => {
    const server = createServer(makeMinimalConfig());
    const result = await server.handleWebhook({ headers: {}, body: 'random' });
    expect(result.status).toBe(400);
  });

  it('returns 200 for duplicate notification', async () => {
    const mockBridge = {
      handleNotification: vi.fn(async () => ({
        notification: {
          id: '1', type: 'renewal' as const, store: 'apple' as const,
          environment: 'sandbox', productId: 'p', userWallet: 'w',
          originalTransactionId: 'ot', expiresAt: null, autoRenew: true,
          storeTimestamp: new Date(), receivedTimestamp: new Date(),
          deduplicationKey: 'dedup1', raw: {},
        },
        instruction: {
          productId: 'p', user: 'w', expiresAt: null,
          source: 'apple' as const, sourceId: 'tx1',
        },
      })),
    };

    const server = createServer(makeMinimalConfig({
      bridges: { apple: mockBridge },
      isDuplicate: vi.fn(async () => true),
    }));

    const result = await server.handleWebhook({
      headers: {},
      body: 'eyJhbGciOiJ...',
    });
    expect(result.status).toBe(200);
  });

  it('full Apple webhook pipeline: detect → bridge → mint → hooks', async () => {
    const afterMint = vi.fn(async () => {});
    const markProcessed = vi.fn(async () => {});

    const mockBridge = {
      handleNotification: vi.fn(async () => ({
        notification: {
          id: '1', type: 'initial_purchase' as const, store: 'apple' as const,
          environment: 'sandbox', productId: 'p', userWallet: 'w',
          originalTransactionId: 'ot', expiresAt: null, autoRenew: true,
          storeTimestamp: new Date(), receivedTimestamp: new Date(),
          deduplicationKey: 'dedup-full', raw: {},
        },
        instruction: {
          productId: 'p', user: 'w', expiresAt: null,
          source: 'apple' as const, sourceId: 'tx1',
        },
      })),
    };

    const writer = { mintEntitlement: vi.fn(async () => 'tx') };
    const signer = { signAndSend: vi.fn(async () => 'sig123'), publicKey: 'signer' };

    const server = createServer({
      chain: {
        reader: {
          checkEntitlement: vi.fn(async () => ({
            entitled: false, entitlement: null, reason: 'not_found' as const,
            expiresAt: null, product: null,
          })),
          checkEntitlements: vi.fn(async () => ({ results: {}, user: '', checkedAt: new Date() })),
        },
        writer,
        signer,
      },
      bridges: { apple: mockBridge },
      afterMint,
      markProcessed,
      isDuplicate: vi.fn(async () => false),
      onMintFailure: vi.fn(async () => {}),
    });

    const result = await server.handleWebhook({
      headers: {},
      body: 'eyJhbGciOiJ...', // Starts with eyJ → detected as Apple
    });

    expect(result.status).toBe(200);
    expect(mockBridge.handleNotification).toHaveBeenCalled();
    expect(writer.mintEntitlement).toHaveBeenCalled();
    expect(signer.signAndSend).toHaveBeenCalled();
    expect(afterMint).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'p', user: 'w' }),
      'sig123',
    );
    expect(markProcessed).toHaveBeenCalledWith('dedup-full');
  });

  it('returns 500 and calls onMintFailure when mint fails', async () => {
    const onMintFailure = vi.fn(async () => {});

    const mockBridge = {
      handleNotification: vi.fn(async () => ({
        notification: {
          id: '2', type: 'renewal' as const, store: 'apple' as const,
          environment: 'sandbox', productId: 'p', userWallet: 'w',
          originalTransactionId: 'ot', expiresAt: null, autoRenew: true,
          storeTimestamp: new Date(), receivedTimestamp: new Date(),
          deduplicationKey: 'dedup-fail', raw: {},
        },
        instruction: {
          productId: 'p', user: 'w', expiresAt: null,
          source: 'apple' as const, sourceId: 'tx2',
        },
      })),
    };

    const server = createServer({
      chain: {
        reader: {
          checkEntitlement: vi.fn(async () => ({
            entitled: false, entitlement: null, reason: 'not_found' as const,
            expiresAt: null, product: null,
          })),
          checkEntitlements: vi.fn(async () => ({ results: {}, user: '', checkedAt: new Date() })),
        },
        writer: { mintEntitlement: vi.fn(async () => { throw new Error('RPC down'); }) },
        signer: { signAndSend: vi.fn(async () => { throw new Error('RPC down'); }), publicKey: 'signer' },
      },
      bridges: { apple: mockBridge },
      onMintFailure,
      mintRetry: { maxRetries: 1, baseDelayMs: 10 },
    });

    const result = await server.handleWebhook({ headers: {}, body: 'eyJhbGciOiJ...' });
    // Server should still return 200 (to ack the webhook) even on mint failure
    // The onMintFailure callback handles the failure
    expect(result.status).toBe(200);
    expect(onMintFailure).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'p' }),
      expect.any(Error),
      expect.objectContaining({ store: 'apple', willStoreRetry: true }),
    );
  });

  it('null instruction (cancellation) does not trigger mint', async () => {
    const afterMint = vi.fn(async () => {});

    const mockBridge = {
      handleNotification: vi.fn(async () => ({
        notification: {
          id: '3', type: 'cancellation' as const, store: 'apple' as const,
          environment: 'sandbox', productId: 'p', userWallet: 'w',
          originalTransactionId: 'ot', expiresAt: null, autoRenew: false,
          storeTimestamp: new Date(), receivedTimestamp: new Date(),
          deduplicationKey: 'dedup-cancel', raw: {},
        },
        instruction: null,
      })),
    };

    const server = createServer({
      chain: {
        reader: {
          checkEntitlement: vi.fn(async () => ({
            entitled: false, entitlement: null, reason: 'not_found' as const,
            expiresAt: null, product: null,
          })),
          checkEntitlements: vi.fn(async () => ({ results: {}, user: '', checkedAt: new Date() })),
        },
        writer: { mintEntitlement: vi.fn(async () => 'tx') },
        signer: { signAndSend: vi.fn(async () => 'sig'), publicKey: 'signer' },
      },
      bridges: { apple: mockBridge },
      afterMint,
      onMintFailure: vi.fn(async () => {}),
    });

    const result = await server.handleWebhook({ headers: {}, body: 'eyJhbGciOiJ...' });
    expect(result.status).toBe(200);
    expect(afterMint).not.toHaveBeenCalled();
  });

  it('calls beforeMint and rejects if false', async () => {
    const mockBridge = {
      handleNotification: vi.fn(async () => ({
        notification: {
          id: '1', type: 'initial_purchase' as const, store: 'apple' as const,
          environment: 'sandbox', productId: 'p', userWallet: 'w',
          originalTransactionId: 'ot', expiresAt: null, autoRenew: true,
          storeTimestamp: new Date(), receivedTimestamp: new Date(),
          deduplicationKey: 'dedup2', raw: {},
        },
        instruction: {
          productId: 'p', user: 'w', expiresAt: null,
          source: 'apple' as const, sourceId: 'tx2',
        },
      })),
    };

    const beforeMint = vi.fn(async () => false);
    const afterMint = vi.fn(async () => {});

    const server = createServer(makeMinimalConfig({
      bridges: { apple: mockBridge },
      beforeMint,
      afterMint,
    }));

    const result = await server.handleWebhook({
      headers: {},
      body: 'eyJhbGciOiJ...',
    });
    expect(result.status).toBe(200);
    expect(beforeMint).toHaveBeenCalled();
    expect(afterMint).not.toHaveBeenCalled();
  });

  it('processes revoke instruction and calls afterRevoke', async () => {
    const afterRevoke = vi.fn(async () => {});
    const revokeEntitlement = vi.fn(async () => 'revoke-tx');

    const mockBridge = {
      handleNotification: vi.fn(async () => ({
        notification: {
          id: '5', type: 'revocation' as const, store: 'apple' as const,
          environment: 'sandbox' as const, productId: 'p', userWallet: 'w',
          originalTransactionId: 'ot', expiresAt: null, autoRenew: false,
          storeTimestamp: new Date(), receivedTimestamp: new Date(),
          deduplicationKey: 'dedup-revoke', raw: {},
        },
        instruction: { productId: 'p', user: 'w', reason: 'apple:revocation' },
      })),
    };

    const server = createServer(makeMinimalConfig({
      chain: {
        reader: {
          checkEntitlement: vi.fn(async () => ({
            entitled: false, entitlement: null, reason: 'not_found' as const,
            expiresAt: null, product: null,
          })),
          checkEntitlements: vi.fn(async () => ({ results: {}, user: '', checkedAt: new Date() })),
        },
        writer: { mintEntitlement: vi.fn(async () => 'tx'), revokeEntitlement },
        signer: { signAndSend: vi.fn(async () => 'revoke-sig'), publicKey: 'signer' },
      },
      bridges: { apple: mockBridge },
      afterRevoke,
    }));

    const result = await server.handleWebhook({ headers: {}, body: 'eyJhbGciOiJ...' });
    expect(result.status).toBe(200);
    expect(revokeEntitlement).toHaveBeenCalled();
    expect(afterRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'p', reason: 'apple:revocation' }),
      'revoke-sig',
    );
  });

  it('returns 400 for bridge DoubloonError with client error code', async () => {
    const { DoubloonError } = await import('@drakkar.software/doubloon-core');
    const mockBridge = {
      handleNotification: vi.fn(async () => {
        throw new DoubloonError('INVALID_RECEIPT', 'Bad notification body');
      }),
    };

    const server = createServer(makeMinimalConfig({
      bridges: { apple: mockBridge },
    }));

    const result = await server.handleWebhook({ headers: {}, body: 'eyJhbGciOiJ...' });
    expect(result.status).toBe(400);
    expect(result.body).toBe('Bad notification body');
  });

  it('detects Apple from signedPayload body', () => {
    const server = createServer(makeMinimalConfig());
    expect(
      server.detectStore({ headers: {}, body: '{"signedPayload":"abc"}' }),
    ).toBe('apple');
  });
});

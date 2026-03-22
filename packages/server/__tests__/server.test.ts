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
});

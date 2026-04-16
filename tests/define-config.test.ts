/**
 * Tests for defineConfig() — product registration, config assembly, and
 * auto-registration on local chain stores.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { defineConfig } from '@doubloon/server';
import { createServer } from '@doubloon/server';
import { createLocalChain } from '@doubloon/chain-local';
import { vi } from 'vitest';

const PRODUCTS = [
  { slug: 'pro-monthly', name: 'Pro Monthly', defaultDuration: 2592000 },
  { slug: 'lifetime', name: 'Lifetime', defaultDuration: 0 },
];

const noop = vi.fn(async () => {});

describe('defineConfig — validation', () => {
  it('throws on empty products', () => {
    const local = createLocalChain();
    expect(() =>
      defineConfig({ products: [], destination: local, onMintFailure: noop }),
    ).toThrow('at least one product required');
  });

  it('throws on invalid slug', () => {
    const local = createLocalChain();
    expect(() =>
      defineConfig({
        products: [{ slug: 'INVALID SLUG', name: 'Bad', defaultDuration: 0 }],
        destination: local,
        onMintFailure: noop,
      }),
    ).toThrow('lowercase alphanumeric');
  });

  it('throws on duplicate slug', () => {
    const local = createLocalChain();
    expect(() =>
      defineConfig({
        products: [
          { slug: 'pro', name: 'Pro A', defaultDuration: 0 },
          { slug: 'pro', name: 'Pro B', defaultDuration: 0 },
        ],
        destination: local,
        onMintFailure: noop,
      }),
    ).toThrow('Duplicate slug: "pro"');
  });
});

describe('defineConfig — local chain auto-registration', () => {
  it('auto-registers products on local store', () => {
    const local = createLocalChain();
    const { registry } = defineConfig({ products: PRODUCTS, destination: local, onMintFailure: noop });

    for (const entry of registry.entries()) {
      const product = local.store.getProduct(entry.productId);
      expect(product).not.toBeNull();
      expect(product!.name).toBe(entry.name);
    }
  });

  it('does not double-register already-registered products', () => {
    const local = createLocalChain();
    const { registry } = defineConfig({ products: PRODUCTS, destination: local, onMintFailure: noop });

    // Call again — should not throw and store should still be consistent
    expect(() =>
      defineConfig({ products: PRODUCTS, destination: local, onMintFailure: noop }),
    ).not.toThrow();

    expect(local.store.productCount).toBe(PRODUCTS.length);
  });
});

describe('defineConfig — registry', () => {
  it('returns registry with correct slug<->productId mappings', () => {
    const local = createLocalChain();
    const { registry } = defineConfig({ products: PRODUCTS, destination: local, onMintFailure: noop });

    const proId = registry.getProductId('pro-monthly');
    expect(registry.getSlug(proId)).toBe('pro-monthly');
    expect(registry.size).toBe(2);
  });
});

describe('defineConfig — serverConfig assembly', () => {
  it('produces a valid ServerConfig that createServer() accepts', () => {
    const local = createLocalChain();
    const { serverConfig } = defineConfig({ products: PRODUCTS, destination: local, onMintFailure: noop });

    expect(() => createServer(serverConfig)).not.toThrow();
  });

  it('passes bridges through to serverConfig', () => {
    const local = createLocalChain();
    const mockBridge = { handleNotification: vi.fn() };
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: local,
      bridges: { stripe: mockBridge as any },
      onMintFailure: noop,
    });

    expect(serverConfig.bridges.stripe).toBe(mockBridge);
  });

  it('passes hooks through to serverConfig', () => {
    const local = createLocalChain();
    const afterMint = vi.fn(async () => {});
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: local,
      hooks: { afterMint },
      onMintFailure: noop,
    });

    expect(serverConfig.afterMint).toBe(afterMint);
  });
});

describe('defineConfig + createServer — full webhook flow with local chain', () => {
  let server: ReturnType<typeof createServer>;
  let local: ReturnType<typeof createLocalChain>;

  beforeEach(() => {
    local = createLocalChain();
    const { serverConfig, registry } = defineConfig({
      products: PRODUCTS,
      destination: local,
      onMintFailure: noop,
    });
    server = createServer(serverConfig);
  });

  it('processes a webhook and grants entitlement', async () => {
    const PRO_ID = Object.values(
      (await server.checkEntitlements(['pro-monthly'], 'wallet-1')).results,
    );
    // Try using direct local chain interaction instead
    const { registry } = defineConfig({
      products: PRODUCTS,
      destination: local,
      onMintFailure: noop,
    });
    const proId = registry.getProductId('pro-monthly');

    // Simulate bridge notification via processInstruction
    await server.processInstruction(
      { productId: proId, user: 'wallet-1', expiresAt: null, source: 'stripe', sourceId: 'sub_001' },
      { id: 'evt_1', type: 'initial_purchase', store: 'stripe', environment: 'production',
        productId: proId, userWallet: 'wallet-1', originalTransactionId: 'sub_001',
        expiresAt: null, autoRenew: false, storeTimestamp: new Date(), receivedTimestamp: new Date(),
        deduplicationKey: 'stripe:initial_purchase:evt_1', raw: {} },
      'stripe',
    );

    const check = await server.checkEntitlement(proId, 'wallet-1');
    expect(check.entitled).toBe(true);
  });
});

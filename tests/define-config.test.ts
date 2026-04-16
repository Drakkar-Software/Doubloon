/**
 * Tests for defineConfig() — product registration, config assembly.
 */

import { describe, it, expect, vi } from 'vitest';
import { defineConfig } from '@drakkar.software/doubloon-server';
import { createServer } from '@drakkar.software/doubloon-server';

const PRODUCTS = [
  { slug: 'pro-monthly', name: 'Pro Monthly', defaultDuration: 2592000 },
  { slug: 'lifetime', name: 'Lifetime', defaultDuration: 0 },
];

function makeMockDestination() {
  return {
    reader: {
      checkEntitlement: vi.fn(),
      checkEntitlements: vi.fn(),
      getEntitlement: vi.fn(),
      getProduct: vi.fn(),
    },
    writer: { mintEntitlement: vi.fn(), revokeEntitlement: vi.fn() },
    signer: { signAndSend: vi.fn(), publicKey: 'mock-key' },
  };
}

const noop = vi.fn(async () => {});

describe('defineConfig — validation', () => {
  it('throws on empty products', () => {
    expect(() =>
      defineConfig({ products: [], destination: makeMockDestination(), onMintFailure: noop }),
    ).toThrow('at least one product required');
  });

  it('throws on invalid slug', () => {
    expect(() =>
      defineConfig({
        products: [{ slug: 'INVALID SLUG', name: 'Bad', defaultDuration: 0 }],
        destination: makeMockDestination(),
        onMintFailure: noop,
      }),
    ).toThrow('lowercase alphanumeric');
  });

  it('throws on duplicate slug', () => {
    expect(() =>
      defineConfig({
        products: [
          { slug: 'pro', name: 'Pro A', defaultDuration: 0 },
          { slug: 'pro', name: 'Pro B', defaultDuration: 0 },
        ],
        destination: makeMockDestination(),
        onMintFailure: noop,
      }),
    ).toThrow('Duplicate slug: "pro"');
  });
});

describe('defineConfig — registry', () => {
  it('returns registry with correct slug<->productId mappings', () => {
    const { registry } = defineConfig({
      products: PRODUCTS,
      destination: makeMockDestination(),
      onMintFailure: noop,
    });

    const proId = registry.getProductId('pro-monthly');
    expect(registry.getSlug(proId)).toBe('pro-monthly');
    expect(registry.size).toBe(2);
  });
});

describe('defineConfig — serverConfig assembly', () => {
  it('produces a valid ServerConfig that createServer() accepts', () => {
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: makeMockDestination(),
      onMintFailure: noop,
    });

    expect(() => createServer(serverConfig)).not.toThrow();
  });

  it('passes bridges through to serverConfig', () => {
    const mockBridge = { handleNotification: vi.fn() };
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: makeMockDestination(),
      bridges: { stripe: mockBridge as any },
      onMintFailure: noop,
    });

    expect(serverConfig.bridges.stripe).toBe(mockBridge);
  });

  it('passes hooks through to serverConfig', () => {
    const afterMint = vi.fn(async () => {});
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: makeMockDestination(),
      hooks: { afterMint },
      onMintFailure: noop,
    });

    expect(serverConfig.afterMint).toBe(afterMint);
  });

  it('passes webhookSecret through to serverConfig', () => {
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: makeMockDestination(),
      webhookSecret: 'my-secret',
      onMintFailure: noop,
    });

    expect(serverConfig.webhookSecret).toBe('my-secret');
  });
});

describe('webhook secret verification', () => {
  function makeServer(secret?: string) {
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: makeMockDestination(),
      webhookSecret: secret,
      onMintFailure: noop,
    });
    return createServer(serverConfig);
  }

  const stripeBody = Buffer.from(JSON.stringify({ type: 'customer.subscription.created' }));

  it('returns 401 when secret configured but header missing', async () => {
    const server = makeServer('super-secret');
    const res = await server.handleWebhook({ headers: {}, body: stripeBody });
    expect(res.status).toBe(401);
  });

  it('returns 401 when secret header is wrong', async () => {
    const server = makeServer('super-secret');
    const res = await server.handleWebhook({
      headers: { 'x-doubloon-secret': 'wrong-secret' },
      body: stripeBody,
    });
    expect(res.status).toBe(401);
  });

  it('passes through when secret matches', async () => {
    const server = makeServer('super-secret');
    const res = await server.handleWebhook({
      headers: { 'x-doubloon-secret': 'super-secret' },
      body: stripeBody,
    });
    // Not 401 — proceeds to store detection (may fail later on bridge logic, but not auth)
    expect(res.status).not.toBe(401);
  });

  it('skips check when no secret configured', async () => {
    const server = makeServer(undefined);
    const res = await server.handleWebhook({ headers: {}, body: stripeBody });
    // No secret configured — should not get 401
    expect(res.status).not.toBe(401);
  });
});

describe('custom bridge', () => {
  function makeNotification(store: string) {
    return {
      id: 'notif-1',
      type: 'initial_purchase' as const,
      store: store as any,
      environment: 'production' as const,
      productId: 'pid-1',
      userWallet: 'wallet-1',
      originalTransactionId: 'txn-1',
      expiresAt: null,
      autoRenew: false,
      storeTimestamp: new Date(),
      receivedTimestamp: new Date(),
      deduplicationKey: `${store}:notif-1`,
      raw: {},
    };
  }

  function makeCustomServer(bridgeName: string) {
    const bridge = {
      handleNotification: vi.fn().mockResolvedValue({
        notification: makeNotification(bridgeName),
        instruction: null,
      }),
    };
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: makeMockDestination(),
      bridges: { [bridgeName]: bridge },
      onMintFailure: noop,
    });
    return { server: createServer(serverConfig), bridge };
  }

  it('routes to custom bridge via x-doubloon-bridge header', async () => {
    const { server, bridge } = makeCustomServer('coinbase');
    const res = await server.handleWebhook({
      headers: { 'x-doubloon-bridge': 'coinbase' },
      body: Buffer.from('{}'),
    });
    expect(res.status).toBe(200);
    expect(bridge.handleNotification).toHaveBeenCalledOnce();
  });

  it('returns 404 when custom bridge key not registered', async () => {
    const { server } = makeCustomServer('coinbase');
    const res = await server.handleWebhook({
      headers: { 'x-doubloon-bridge': 'unknown-store' },
      body: Buffer.from('{}'),
    });
    expect(res.status).toBe(404);
  });

  it('x-doubloon-bridge overrides auto-detection for built-in stores', async () => {
    const customStripe = {
      handleNotification: vi.fn().mockResolvedValue({
        notification: makeNotification('stripe'),
        instruction: null,
      }),
    };
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: makeMockDestination(),
      bridges: { stripe: customStripe },
      onMintFailure: noop,
    });
    const server = createServer(serverConfig);
    const res = await server.handleWebhook({
      headers: { 'x-doubloon-bridge': 'stripe' },
      body: Buffer.from('{}'),
    });
    expect(res.status).toBe(200);
    expect(customStripe.handleNotification).toHaveBeenCalledOnce();
  });
});

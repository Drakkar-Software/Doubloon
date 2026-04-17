import { describe, it, expect, vi } from 'vitest';
import { createServer, defineConfig } from '@drakkar.software/doubloon-server';
import type { Bridge } from '@drakkar.software/doubloon-core';
import { deriveProductIdHex } from '@drakkar.software/doubloon-core';
import { createNamespacedServer } from '@drakkar.software/doubloon-server';

const PRODUCTS = [{ slug: 'pro', name: 'Pro', defaultDuration: 2592000 }];
const PRO_ID = deriveProductIdHex('pro');

function makeMockDestination() {
  return {
    reader: {
      checkEntitlement: vi.fn().mockResolvedValue({ entitled: false, entitlement: null, reason: 'not_found', expiresAt: null, product: null }),
      checkEntitlements: vi.fn(),
      getEntitlement: vi.fn().mockResolvedValue(null),
      getProduct: vi.fn().mockResolvedValue(null),
    },
    writer: { mintEntitlement: vi.fn().mockResolvedValue({ _type: 'mock-tx' }), revokeEntitlement: vi.fn() },
    signer: { signAndSend: vi.fn().mockResolvedValue('mock-sig'), publicKey: 'mock-key' },
  };
}

function makeBridge(environment: 'production' | 'sandbox'): Bridge {
  return {
    handleNotification: vi.fn().mockResolvedValue({
      notification: {
        id: 'notif-1',
        type: 'initial_purchase',
        store: 'stripe',
        environment,
        productId: PRO_ID,
        userWallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        originalTransactionId: 'tx-1',
        expiresAt: null,
        autoRenew: false,
        storeTimestamp: new Date(),
        receivedTimestamp: new Date(),
        deduplicationKey: `stripe:initial_purchase:${Date.now()}:${Math.random()}`,
        raw: {},
      },
      instruction: {
        productId: PRO_ID,
        user: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        expiresAt: null,
        source: 'stripe',
        sourceId: 'tx-1',
      },
    }),
  };
}

const noop = vi.fn(async () => {});

describe('server mode enforcement', () => {
  it('mode=production rejects sandbox event with 400', async () => {
    const dest = makeMockDestination();
    const sandboxBridge = makeBridge('sandbox');
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: dest,
      bridges: { stripe: sandboxBridge },
      onMintFailure: noop,
      mode: 'production',
    });

    const server = createServer(serverConfig);
    const result = await server.handleWebhook({
      headers: { 'stripe-signature': 'sig' },
      body: Buffer.from('{}'),
    });

    expect(result.status).toBe(400);
    expect(result.body).toContain('environment mismatch');
    expect(dest.writer.mintEntitlement).not.toHaveBeenCalled();
  });

  it('mode=sandbox rejects production event with 400', async () => {
    const dest = makeMockDestination();
    const prodBridge = makeBridge('production');
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: dest,
      bridges: { stripe: prodBridge },
      onMintFailure: noop,
      mode: 'sandbox',
    });

    const server = createServer(serverConfig);
    const result = await server.handleWebhook({
      headers: { 'stripe-signature': 'sig' },
      body: Buffer.from('{}'),
    });

    expect(result.status).toBe(400);
    expect(result.body).toContain('environment mismatch');
    expect(dest.writer.mintEntitlement).not.toHaveBeenCalled();
  });

  it('no mode set accepts both production and sandbox events', async () => {
    const dest = makeMockDestination();
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: dest,
      bridges: { stripe: makeBridge('production') },
      onMintFailure: noop,
    });
    const server = createServer(serverConfig);

    const r1 = await server.handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') });
    expect(r1.status).toBe(200);
  });

  it('mode=production accepts production events', async () => {
    const dest = makeMockDestination();
    const { serverConfig } = defineConfig({
      products: PRODUCTS,
      destination: dest,
      bridges: { stripe: makeBridge('production') },
      onMintFailure: noop,
      mode: 'production',
    });
    const server = createServer(serverConfig);

    const result = await server.handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') });
    expect(result.status).toBe(200);
    expect(dest.writer.mintEntitlement).toHaveBeenCalledOnce();
  });
});

describe('namespaced server per-namespace mode', () => {
  it('prod namespace rejects sandbox events, sandbox namespace accepts them', async () => {
    const destProd = makeMockDestination();
    const destSandbox = makeMockDestination();

    const ns = createNamespacedServer({
      namespaces: {
        prod: { products: PRODUCTS, destination: destProd, bridges: { stripe: makeBridge('sandbox') }, mode: 'production' },
        staging: { products: PRODUCTS, destination: destSandbox, bridges: { stripe: makeBridge('sandbox') }, mode: 'sandbox' },
      },
      onMintFailure: noop,
    });

    const prodResult = await ns.handleRequest({
      method: 'POST', url: '/prod/webhook',
      headers: { 'stripe-signature': 'sig' },
      body: Buffer.from('{}'),
    });
    expect(prodResult.status).toBe(400);
    expect(destProd.writer.mintEntitlement).not.toHaveBeenCalled();

    const stagingResult = await ns.handleRequest({
      method: 'POST', url: '/staging/webhook',
      headers: { 'stripe-signature': 'sig' },
      body: Buffer.from('{}'),
    });
    expect(stagingResult.status).toBe(200);
    expect(destSandbox.writer.mintEntitlement).toHaveBeenCalledOnce();
  });
});

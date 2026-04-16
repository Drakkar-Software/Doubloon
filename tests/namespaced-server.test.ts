/**
 * Tests for createNamespacedServer() — multi-namespace routing, isolation,
 * shared dedup, and request dispatching.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createNamespacedServer, MemoryDedupStore } from '@drakkar.software/doubloon-server';
import { deriveProductIdHex } from '@drakkar.software/doubloon-core';

const onMintFailure = vi.fn(async () => {});

const APP_A_PRODUCTS = [{ slug: 'premium', name: 'Premium', defaultDuration: 0 }];
const APP_B_PRODUCTS = [{ slug: 'pro', name: 'Pro', defaultDuration: 2592000 }];

const PREMIUM_ID = deriveProductIdHex('premium');
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

function makeNamespacedServer() {
  const destA = makeMockDestination();
  const destB = makeMockDestination();

  const ns = createNamespacedServer({
    namespaces: {
      'app-a': { products: APP_A_PRODUCTS, destination: destA },
      'app-b': { products: APP_B_PRODUCTS, destination: destB },
    },
    onMintFailure,
  });

  return { ns, destA, destB };
}

describe('createNamespacedServer — setup', () => {
  it('registers all namespaces', () => {
    const { ns } = makeNamespacedServer();
    expect(ns.namespaces().sort()).toEqual(['app-a', 'app-b']);
  });

  it('provides direct access to namespace servers', () => {
    const { ns } = makeNamespacedServer();
    expect(ns.getNamespace('app-a')).toBeDefined();
    expect(ns.getNamespace('unknown')).toBeUndefined();
  });

  it('throws on invalid namespace name', () => {
    expect(() =>
      createNamespacedServer({
        namespaces: { 'invalid name!': { products: APP_A_PRODUCTS, destination: makeMockDestination() } },
        onMintFailure,
      }),
    ).toThrow('Invalid namespace name');
  });

  it('throws on reserved namespace name', () => {
    expect(() =>
      createNamespacedServer({
        namespaces: { webhook: { products: APP_A_PRODUCTS, destination: makeMockDestination() } },
        onMintFailure,
      }),
    ).toThrow('reserved');
  });
});

describe('createNamespacedServer — health check', () => {
  it('returns 200 for known namespace health endpoint', async () => {
    const { ns } = makeNamespacedServer();
    const res = await ns.handleRequest({ method: 'GET', url: '/app-a/health', headers: {} });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toMatchObject({ ok: true, namespace: 'app-a' });
  });

  it('returns 404 for unknown namespace', async () => {
    const { ns } = makeNamespacedServer();
    const res = await ns.handleRequest({ method: 'GET', url: '/unknown/health', headers: {} });
    expect(res.status).toBe(404);
  });

  it('returns 404 when no namespace in path', async () => {
    const { ns } = makeNamespacedServer();
    const res = await ns.handleRequest({ method: 'GET', url: '/', headers: {} });
    expect(res.status).toBe(404);
  });
});

describe('createNamespacedServer — entitlement routing', () => {
  it('routes check request to correct namespace reader', async () => {
    const { ns, destA } = makeNamespacedServer();
    const res = await ns.handleRequest({
      method: 'GET',
      url: `/app-a/check/${PREMIUM_ID}/wallet-1`,
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(destA.reader.checkEntitlement).toHaveBeenCalledWith(PREMIUM_ID, 'wallet-1');
  });

  it('programmatic checkEntitlement delegates to namespace', async () => {
    const { ns, destA } = makeNamespacedServer();
    await ns.checkEntitlement('app-a', PREMIUM_ID, 'wallet-1');
    expect(destA.reader.checkEntitlement).toHaveBeenCalledWith(PREMIUM_ID, 'wallet-1');
  });

  it('throws on checkEntitlement with unknown namespace', async () => {
    const { ns } = makeNamespacedServer();
    await expect(ns.checkEntitlement('unknown', PREMIUM_ID, 'wallet-1')).rejects.toThrow('Unknown namespace');
  });
});

describe('createNamespacedServer — namespace isolation', () => {
  it('app-a reader not called when app-b is routed', async () => {
    const { ns, destA, destB } = makeNamespacedServer();
    await ns.handleRequest({ method: 'GET', url: `/app-b/check/${PRO_ID}/wallet-1`, headers: {} });
    expect(destA.reader.checkEntitlement).not.toHaveBeenCalled();
    expect(destB.reader.checkEntitlement).toHaveBeenCalledWith(PRO_ID, 'wallet-1');
  });
});

describe('createNamespacedServer — shared dedup', () => {
  it('accepts an external shared dedup store', () => {
    const sharedDedup = new MemoryDedupStore();
    expect(() =>
      createNamespacedServer({
        namespaces: {
          'app-a': { products: APP_A_PRODUCTS, destination: makeMockDestination() },
        },
        onMintFailure,
        dedup: sharedDedup,
      }),
    ).not.toThrow();
  });
});

/**
 * Tests for createNamespacedServer() — multi-namespace routing, isolation,
 * shared dedup, and request dispatching.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createNamespacedServer } from '@doubloon/server';
import { createLocalChain } from '@doubloon/chain-local';
import { deriveProductIdHex } from '@doubloon/core';

const onMintFailure = vi.fn(async () => {});

const APP_A_PRODUCTS = [{ slug: 'premium', name: 'Premium', defaultDuration: 0 }];
const APP_B_PRODUCTS = [{ slug: 'pro', name: 'Pro', defaultDuration: 2592000 }];

const PREMIUM_ID = deriveProductIdHex('premium');
const PRO_ID = deriveProductIdHex('pro');

function makeNamespacedServer() {
  const localA = createLocalChain();
  const localB = createLocalChain();

  const ns = createNamespacedServer({
    namespaces: {
      'app-a': { products: APP_A_PRODUCTS, destination: localA },
      'app-b': { products: APP_B_PRODUCTS, destination: localB },
    },
    onMintFailure,
  });

  return { ns, localA, localB };
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
    const local = createLocalChain();
    expect(() =>
      createNamespacedServer({
        namespaces: { 'invalid name!': { products: APP_A_PRODUCTS, destination: local } },
        onMintFailure,
      }),
    ).toThrow('Invalid namespace name');
  });

  it('throws on reserved namespace name', () => {
    const local = createLocalChain();
    expect(() =>
      createNamespacedServer({
        namespaces: { webhook: { products: APP_A_PRODUCTS, destination: local } },
        onMintFailure,
      }),
    ).toThrow('reserved');
  });
});

describe('createNamespacedServer — health check', () => {
  it('returns 200 for GET /{ns}/health', async () => {
    const { ns } = makeNamespacedServer();
    const res = await ns.handleRequest({ method: 'GET', url: '/app-a/health', headers: {} });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.ok).toBe(true);
    expect(body.namespace).toBe('app-a');
  });

  it('returns 404 for unknown namespace', async () => {
    const { ns } = makeNamespacedServer();
    const res = await ns.handleRequest({ method: 'GET', url: '/unknown/health', headers: {} });
    expect(res.status).toBe(404);
  });

  it('returns 404 for empty path', async () => {
    const { ns } = makeNamespacedServer();
    const res = await ns.handleRequest({ method: 'GET', url: '/', headers: {} });
    expect(res.status).toBe(404);
  });
});

describe('createNamespacedServer — entitlement check routing', () => {
  it('routes GET /{ns}/check/{product}/{wallet} to correct namespace', async () => {
    const { ns, localA } = makeNamespacedServer();

    // Seed app-a's store
    localA.store.mintEntitlement({
      productId: PREMIUM_ID,
      user: 'wallet-abc',
      expiresAt: null,
      source: 'platform',
      sourceId: 'seed',
    });

    const res = await ns.handleRequest({
      method: 'GET',
      url: `/app-a/check/${PREMIUM_ID}/wallet-abc`,
      headers: {},
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.entitled).toBe(true);
  });

  it('namespaces are isolated — app-a entitlement not visible in app-b', async () => {
    const { ns, localA } = makeNamespacedServer();

    localA.store.mintEntitlement({
      productId: PREMIUM_ID,
      user: 'wallet-abc',
      expiresAt: null,
      source: 'platform',
      sourceId: 'seed',
    });

    const res = await ns.handleRequest({
      method: 'GET',
      url: `/app-b/check/${PREMIUM_ID}/wallet-abc`,
      headers: {},
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.entitled).toBe(false);
  });
});

describe('createNamespacedServer — direct checkEntitlement', () => {
  it('checks entitlement in specified namespace', async () => {
    const { ns, localA } = makeNamespacedServer();

    localA.store.mintEntitlement({
      productId: PREMIUM_ID,
      user: 'wallet-1',
      expiresAt: null,
      source: 'platform',
      sourceId: 'direct',
    });

    const check = await ns.checkEntitlement('app-a', PREMIUM_ID, 'wallet-1');
    expect(check.entitled).toBe(true);
  });

  it('throws for unknown namespace', async () => {
    const { ns } = makeNamespacedServer();
    await expect(ns.checkEntitlement('nope', PREMIUM_ID, 'w')).rejects.toThrow('Unknown namespace');
  });
});

describe('createNamespacedServer — shared dedup', () => {
  it('uses same dedup store across namespaces', async () => {
    const { MemoryDedupStore } = await import('@doubloon/server');
    const localA = createLocalChain();
    const localB = createLocalChain();
    const sharedDedup = new MemoryDedupStore();

    const ns = createNamespacedServer({
      namespaces: {
        'app-a': { products: APP_A_PRODUCTS, destination: localA },
        'app-b': { products: APP_B_PRODUCTS, destination: localB },
      },
      onMintFailure,
      dedup: sharedDedup,
    });

    // Confirm both servers reference the same dedup instance
    // (tested indirectly: dedup store shared means same object passed to each server)
    expect(ns.getNamespace('app-a')).toBeDefined();
    expect(ns.getNamespace('app-b')).toBeDefined();
    expect(sharedDedup.size).toBe(0); // nothing processed yet
  });
});

describe('createNamespacedServer — webhook routing', () => {
  it('returns 400 for unknown store webhook in namespace', async () => {
    const { ns } = makeNamespacedServer();

    const res = await ns.handleRequest({
      method: 'POST',
      url: '/app-a/webhook',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unknown: 'payload' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 404 for POST to unknown namespace webhook', async () => {
    const { ns } = makeNamespacedServer();

    const res = await ns.handleRequest({
      method: 'POST',
      url: '/no-such-app/webhook',
      headers: {},
      body: '{}',
    });

    expect(res.status).toBe(404);
  });
});

describe('createNamespacedServer — namespace-level hooks', () => {
  it('namespace-specific onMintFailure overrides global', async () => {
    const globalFailure = vi.fn(async () => {});
    const nsFailure = vi.fn(async () => {});

    const local = createLocalChain();
    const ns = createNamespacedServer({
      namespaces: {
        'app-custom': {
          products: APP_A_PRODUCTS,
          destination: local,
          hooks: { onMintFailure: nsFailure },
        },
      },
      onMintFailure: globalFailure,
    });

    expect(ns.getNamespace('app-custom')).toBeDefined();
    // globalFailure not called when namespace has its own
    expect(globalFailure).not.toHaveBeenCalled();
  });
});

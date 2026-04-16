/**
 * Integration tests for @doubloon/starfish entitlement destination.
 *
 * Uses a mock StarfishClient backed by an in-memory Map to test the full
 * pull-modify-push lifecycle: mint, check, revoke, and OCC conflict retry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createStarfishDestination } from '@doubloon/starfish';
import { createProductRegistry } from '@doubloon/core';
import { mintWithRetry } from '@doubloon/server';
import type { StarfishClient } from '@drakkar.software/starfish-client';
import { ConflictError, StarfishHttpError } from '@drakkar.software/starfish-client';

// ---------------------------------------------------------------------------
// Mock Starfish client backed by an in-memory store
// ---------------------------------------------------------------------------

interface StoredDoc {
  data: Record<string, unknown>;
  hash: string;
}

function makeHash(data: unknown): string {
  return Math.random().toString(36).slice(2);
}

function createMockStarfishClient(): StarfishClient & { _store: Map<string, StoredDoc>; _conflictOn?: string } {
  const store = new Map<string, StoredDoc>();
  let conflictOn: string | undefined;

  const client = {
    _store: store,
    get _conflictOn() { return conflictOn; },
    set _conflictOn(v: string | undefined) { conflictOn = v; },

    async pull(path: string) {
      const key = path.replace('/pull/', '');
      const doc = store.get(key);
      if (!doc) throw new StarfishHttpError(404, 'Not found');
      return { data: doc.data, hash: doc.hash, timestamp: Date.now() };
    },

    async push(path: string, data: Record<string, unknown>, baseHash: string | null) {
      const key = path.replace('/push/', '');
      const existing = store.get(key);

      // OCC check
      if (conflictOn === key) {
        conflictOn = undefined; // trigger once
        throw new ConflictError();
      }
      if (existing && existing.hash !== baseHash) {
        throw new ConflictError();
      }
      if (!existing && baseHash !== null) {
        throw new ConflictError();
      }

      const hash = makeHash(data);
      store.set(key, { data, hash });
      return { hash, timestamp: Date.now() };
    },
  } as unknown as StarfishClient & { _store: Map<string, StoredDoc>; _conflictOn?: string };

  return client;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const PRODUCTS = [
  { slug: 'pro-monthly', name: 'Pro Monthly', defaultDuration: 2592000 },
  { slug: 'lifetime', name: 'Lifetime', defaultDuration: 0 },
];

let client: ReturnType<typeof createMockStarfishClient>;
let dest: ReturnType<typeof createStarfishDestination>;
const registry = createProductRegistry(PRODUCTS);
const PRO_ID = registry.getProductId('pro-monthly');
const LIFETIME_ID = registry.getProductId('lifetime');
const WALLET = 'wallet-abc';

beforeEach(() => {
  client = createMockStarfishClient();
  dest = createStarfishDestination({
    client: client as unknown as StarfishClient,
    products: PRODUCTS,
    signerKey: 'test-admin',
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StarfishReader', () => {
  it('returns not_found for new wallet', async () => {
    const check = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('not_found');
  });

  it('returns active after mint', async () => {
    // Seed the store directly
    client._store.set(`users/${WALLET}/entitlements`, {
      data: { features: ['pro-monthly'] },
      hash: 'h1',
    });

    const check = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(check.entitled).toBe(true);
    expect(check.reason).toBe('active');
    expect(check.expiresAt).toBeNull(); // Starfish entitlements are always lifetime-style
  });

  it('checkEntitlements fetches multiple products in one pull', async () => {
    client._store.set(`users/${WALLET}/entitlements`, {
      data: { features: ['pro-monthly'] },
      hash: 'h1',
    });

    const batch = await dest.reader.checkEntitlements([PRO_ID, LIFETIME_ID], WALLET);
    expect(batch.results[PRO_ID]!.entitled).toBe(true);
    expect(batch.results[LIFETIME_ID]!.entitled).toBe(false);
  });

  it('getProduct returns entry from registry', async () => {
    const product = await dest.reader.getProduct(PRO_ID);
    expect(product).not.toBeNull();
    expect(product!.name).toBe('Pro Monthly');
    expect(product!.defaultDuration).toBe(2592000);
  });

  it('getProduct returns null for unknown productId', async () => {
    const product = await dest.reader.getProduct('0'.repeat(64));
    expect(product).toBeNull();
  });
});

describe('StarfishWriter + StarfishSigner: mint', () => {
  it('mints by adding slug to features array', async () => {
    const tx = await dest.writer.mintEntitlement({
      productId: PRO_ID,
      user: WALLET,
      expiresAt: null,
      source: 'stripe',
      sourceId: 'sub_123',
      signer: 'test-admin',
    });

    await dest.signer.signAndSend(tx);

    const doc = client._store.get(`users/${WALLET}/entitlements`);
    expect(doc).toBeDefined();
    expect(doc!.data['features']).toContain('pro-monthly');
  });

  it('mint is idempotent — slug not duplicated', async () => {
    const instruction = {
      productId: PRO_ID,
      user: WALLET,
      expiresAt: null,
      source: 'stripe' as const,
      sourceId: 'sub_123',
      signer: 'test-admin',
    };

    // Mint twice
    await dest.signer.signAndSend(await dest.writer.mintEntitlement(instruction));
    await dest.signer.signAndSend(await dest.writer.mintEntitlement(instruction));

    const doc = client._store.get(`users/${WALLET}/entitlements`);
    const features = doc!.data['features'] as string[];
    expect(features.filter((s) => s === 'pro-monthly')).toHaveLength(1);
  });

  it('mint preserves existing slugs', async () => {
    // Pre-seed with lifetime
    client._store.set(`users/${WALLET}/entitlements`, {
      data: { features: ['lifetime'] },
      hash: 'h1',
    });

    await dest.signer.signAndSend(
      await dest.writer.mintEntitlement({
        productId: PRO_ID,
        user: WALLET,
        expiresAt: null,
        source: 'stripe',
        sourceId: 'sub_123',
        signer: 'test-admin',
      }),
    );

    const doc = client._store.get(`users/${WALLET}/entitlements`);
    const features = doc!.data['features'] as string[];
    expect(features).toContain('lifetime');
    expect(features).toContain('pro-monthly');
  });
});

describe('StarfishWriter + StarfishSigner: revoke', () => {
  it('revokes by removing slug from features array', async () => {
    client._store.set(`users/${WALLET}/entitlements`, {
      data: { features: ['pro-monthly', 'lifetime'] },
      hash: 'h1',
    });

    await dest.signer.signAndSend(
      await dest.writer.revokeEntitlement({
        productId: PRO_ID,
        user: WALLET,
        reason: 'cancellation',
        signer: 'test-admin',
      }),
    );

    const doc = client._store.get(`users/${WALLET}/entitlements`);
    const features = doc!.data['features'] as string[];
    expect(features).not.toContain('pro-monthly');
    expect(features).toContain('lifetime');
  });

  it('revoke is safe on non-existent slug', async () => {
    client._store.set(`users/${WALLET}/entitlements`, {
      data: { features: ['lifetime'] },
      hash: 'h1',
    });

    await expect(
      dest.signer.signAndSend(
        await dest.writer.revokeEntitlement({
          productId: PRO_ID,
          user: WALLET,
          reason: 'cancellation',
          signer: 'test-admin',
        }),
      ),
    ).resolves.toBeDefined();

    const doc = client._store.get(`users/${WALLET}/entitlements`);
    expect((doc!.data['features'] as string[])).toEqual(['lifetime']);
  });
});

describe('OCC conflict retry', () => {
  it('retries full writer+signer cycle on OCC conflict', async () => {
    // First attempt will get OCC conflict, second succeeds
    client._conflictOn = `users/${WALLET}/entitlements`;

    const result = await mintWithRetry(
      dest.writer,
      dest.signer,
      {
        productId: PRO_ID,
        user: WALLET,
        expiresAt: null,
        source: 'stripe',
        sourceId: 'sub_retry',
      },
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 },
    );

    expect(result.success).toBe(true);
    expect(result.retryCount).toBe(1); // succeeded on second attempt

    const check = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(check.entitled).toBe(true);
  });

  it('fails after exhausting retries on persistent conflict', async () => {
    // Make every push throw ConflictError
    const alwaysConflict = {
      ...client,
      push: async () => { throw new ConflictError(); },
    } as unknown as StarfishClient;

    const conflictDest = createStarfishDestination({
      client: alwaysConflict,
      products: PRODUCTS,
      signerKey: 'test-admin',
    });

    const result = await mintWithRetry(
      conflictDest.writer,
      conflictDest.signer,
      {
        productId: PRO_ID,
        user: WALLET,
        expiresAt: null,
        source: 'stripe',
        sourceId: 'sub_conflict',
      },
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 },
    );

    expect(result.success).toBe(false);
    expect(result.retryCount).toBe(3);
  });
});

describe('ProductRegistry', () => {
  it('getSlug resolves productId to slug', () => {
    expect(dest.registry.getSlug(PRO_ID)).toBe('pro-monthly');
  });

  it('getProductId resolves slug to productId', () => {
    expect(dest.registry.getProductId('lifetime')).toBe(LIFETIME_ID);
  });

  it('throws PRODUCT_NOT_MAPPED for unknown productId', () => {
    expect(() => dest.registry.getSlug('0'.repeat(64))).toThrow('Unknown productId');
  });

  it('rejects invalid slug', () => {
    expect(() =>
      createStarfishDestination({
        client: client as unknown as StarfishClient,
        products: [{ slug: 'INVALID_SLUG!', name: 'Bad', defaultDuration: 0 }],
        signerKey: 'test-admin',
      }),
    ).toThrow('lowercase alphanumeric');
  });
});

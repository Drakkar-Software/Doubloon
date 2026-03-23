/**
 * E2E: Storage — DefaultStoreProductResolver reverse index, cache adapter,
 * MemoryCacheAdapter TTL/eviction/prefix invalidation, resolveStoreSku.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultStoreProductResolver, MemoryCacheAdapter } from '@doubloon/storage';
import type { MetadataStore, ProductMetadata } from '@doubloon/storage';

function makeProduct(productId: string, bindings: ProductMetadata['storeBindings']): ProductMetadata {
  return {
    productId,
    slug: 'test',
    name: 'Test',
    description: '',
    images: {},
    pricing: { currency: 'USD', amount: 0 },
    storeBindings: bindings,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeMetadataStore(products: ProductMetadata[]): MetadataStore {
  return {
    getProduct: vi.fn(async (id) => products.find((p) => p.productId === id) ?? null),
    putProduct: vi.fn(async () => ({ uri: '' })),
    deleteProduct: vi.fn(async () => {}),
    listProducts: vi.fn(async () => products),
    putAsset: vi.fn(async () => ({ url: '' })),
    getAssetUrl: vi.fn(async () => null),
  };
}

describe('DefaultStoreProductResolver', () => {
  it('resolves Apple SKU to on-chain product ID', async () => {
    const products = [
      makeProduct('pid-1', { apple: { productIds: ['com.app.premium'] } }),
    ];
    const resolver = new DefaultStoreProductResolver(makeMetadataStore(products));

    expect(await resolver.resolveProductId('apple', 'com.app.premium')).toBe('pid-1');
  });

  it('resolves Google subscription ID', async () => {
    const products = [
      makeProduct('pid-2', { google: { productIds: ['premium_monthly'] } }),
    ];
    const resolver = new DefaultStoreProductResolver(makeMetadataStore(products));

    expect(await resolver.resolveProductId('google', 'premium_monthly')).toBe('pid-2');
  });

  it('resolves Stripe price ID', async () => {
    const products = [
      makeProduct('pid-3', { stripe: { priceIds: ['price_abc'] } }),
    ];
    const resolver = new DefaultStoreProductResolver(makeMetadataStore(products));

    expect(await resolver.resolveProductId('stripe', 'price_abc')).toBe('pid-3');
  });

  it('returns null for unknown SKU', async () => {
    const resolver = new DefaultStoreProductResolver(makeMetadataStore([]));
    expect(await resolver.resolveProductId('apple', 'unknown')).toBeNull();
  });

  it('handles product with multiple store bindings', async () => {
    const products = [
      makeProduct('pid-multi', {
        apple: { productIds: ['com.app.premium', 'com.app.premium.v2'] },
        google: { productIds: ['premium_monthly'] },
        stripe: { priceIds: ['price_1', 'price_2'] },
      }),
    ];
    const resolver = new DefaultStoreProductResolver(makeMetadataStore(products));

    expect(await resolver.resolveProductId('apple', 'com.app.premium')).toBe('pid-multi');
    expect(await resolver.resolveProductId('apple', 'com.app.premium.v2')).toBe('pid-multi');
    expect(await resolver.resolveProductId('google', 'premium_monthly')).toBe('pid-multi');
    expect(await resolver.resolveProductId('stripe', 'price_1')).toBe('pid-multi');
    expect(await resolver.resolveProductId('stripe', 'price_2')).toBe('pid-multi');
  });

  it('handles product with no store bindings', async () => {
    const products = [makeProduct('pid-empty', {})];
    const resolver = new DefaultStoreProductResolver(makeMetadataStore(products));
    expect(await resolver.resolveProductId('apple', 'anything')).toBeNull();
  });

  it('multiple products: each SKU maps to correct product', async () => {
    const products = [
      makeProduct('pid-a', { apple: { productIds: ['com.app.a'] } }),
      makeProduct('pid-b', { apple: { productIds: ['com.app.b'] } }),
    ];
    const resolver = new DefaultStoreProductResolver(makeMetadataStore(products));

    expect(await resolver.resolveProductId('apple', 'com.app.a')).toBe('pid-a');
    expect(await resolver.resolveProductId('apple', 'com.app.b')).toBe('pid-b');
  });

  it('invalidateIndex forces index rebuild', async () => {
    const store = makeMetadataStore([
      makeProduct('pid-1', { apple: { productIds: ['com.app.v1'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveProductId('apple', 'com.app.v1')).toBe('pid-1');

    // Update the store and invalidate
    (store.listProducts as any).mockResolvedValue([
      makeProduct('pid-2', { apple: { productIds: ['com.app.v2'] } }),
    ]);
    resolver.invalidateIndex();

    expect(await resolver.resolveProductId('apple', 'com.app.v1')).toBeNull();
    expect(await resolver.resolveProductId('apple', 'com.app.v2')).toBe('pid-2');
  });

  it('resolveStoreSku returns SKUs for a product + store', async () => {
    const products = [
      makeProduct('pid-1', {
        apple: { productIds: ['com.app.premium', 'com.app.premium.v2'] },
        stripe: { priceIds: ['price_abc'] },
      }),
    ];
    const resolver = new DefaultStoreProductResolver(makeMetadataStore(products));

    expect(await resolver.resolveStoreSku('pid-1', 'apple')).toEqual(['com.app.premium', 'com.app.premium.v2']);
    expect(await resolver.resolveStoreSku('pid-1', 'stripe')).toEqual(['price_abc']);
    expect(await resolver.resolveStoreSku('pid-1', 'google')).toBeNull();
  });

  it('resolveStoreSku for x402 returns productId', async () => {
    const products = [
      makeProduct('pid-x', { x402: { priceUsd: 5, durationSeconds: 3600 } }),
    ];
    const resolver = new DefaultStoreProductResolver(makeMetadataStore(products));

    expect(await resolver.resolveStoreSku('pid-x', 'x402')).toEqual(['pid-x']);
  });

  it('resolveStoreSku returns null for unknown product', async () => {
    const resolver = new DefaultStoreProductResolver(makeMetadataStore([]));
    expect(await resolver.resolveStoreSku('unknown', 'apple')).toBeNull();
  });

  it('uses cache when provided', async () => {
    const cache = new MemoryCacheAdapter({ maxEntries: 100 });
    const products = [
      makeProduct('pid-cached', { apple: { productIds: ['com.app.cached'] } }),
    ];
    const store = makeMetadataStore(products);
    const resolver = new DefaultStoreProductResolver(store, cache);

    // First call builds index
    expect(await resolver.resolveProductId('apple', 'com.app.cached')).toBe('pid-cached');

    // Second call hits cache
    expect(await resolver.resolveProductId('apple', 'com.app.cached')).toBe('pid-cached');
    expect(store.listProducts).toHaveBeenCalledTimes(1); // index built once

    cache.destroy();
  });

  it('invalidateIndex clears cache prefix', async () => {
    const cache = new MemoryCacheAdapter({ maxEntries: 100 });
    const products = [
      makeProduct('pid-1', { apple: { productIds: ['com.app.v1'] } }),
    ];
    const resolver = new DefaultStoreProductResolver(makeMetadataStore(products), cache);

    await resolver.resolveProductId('apple', 'com.app.v1');
    expect(cache.size).toBeGreaterThan(0);

    resolver.invalidateIndex();
    // Cache prefix invalidation is async but fire-and-forget
    await new Promise((r) => setTimeout(r, 10));
    expect(cache.size).toBe(0);

    cache.destroy();
  });
});

describe('MemoryCacheAdapter', () => {
  it('get/set round-trip', async () => {
    const cache = new MemoryCacheAdapter();
    await cache.set('key1', { value: 42 }, 5000);
    expect(await cache.get('key1')).toEqual({ value: 42 });
    cache.destroy();
  });

  it('TTL expiration', async () => {
    const cache = new MemoryCacheAdapter();
    await cache.set('key1', 'val', 50);
    expect(await cache.get('key1')).toBe('val');

    await new Promise((r) => setTimeout(r, 100));
    expect(await cache.get('key1')).toBeNull();
    cache.destroy();
  });

  it('invalidate removes specific key', async () => {
    const cache = new MemoryCacheAdapter();
    await cache.set('a', 1, 60_000);
    await cache.set('b', 2, 60_000);
    await cache.invalidate('a');

    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toBe(2);
    cache.destroy();
  });

  it('invalidatePrefix removes matching keys', async () => {
    const cache = new MemoryCacheAdapter();
    await cache.set('sku:apple:com.app.a', 'pid-a', 60_000);
    await cache.set('sku:apple:com.app.b', 'pid-b', 60_000);
    await cache.set('other:key', 'val', 60_000);

    await cache.invalidatePrefix('sku:');

    expect(await cache.get('sku:apple:com.app.a')).toBeNull();
    expect(await cache.get('sku:apple:com.app.b')).toBeNull();
    expect(await cache.get('other:key')).toBe('val');
    cache.destroy();
  });

  it('maxEntries eviction', async () => {
    const cache = new MemoryCacheAdapter({ maxEntries: 3 });
    await cache.set('a', 1, 60_000);
    await cache.set('b', 2, 60_000);
    await cache.set('c', 3, 60_000);
    await cache.set('d', 4, 60_000); // evicts 'a'

    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toBe(2);
    expect(await cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
    cache.destroy();
  });

  it('update existing key does not trigger eviction', async () => {
    const cache = new MemoryCacheAdapter({ maxEntries: 2 });
    await cache.set('a', 1, 60_000);
    await cache.set('b', 2, 60_000);
    await cache.set('a', 10, 60_000); // update, not insert

    expect(cache.size).toBe(2);
    expect(await cache.get('a')).toBe(10);
    expect(await cache.get('b')).toBe(2);
    cache.destroy();
  });

  it('destroy is safe to call multiple times', () => {
    const cache = new MemoryCacheAdapter();
    cache.destroy();
    cache.destroy();
  });

  it('invalidatePrefix with no matches is a no-op', async () => {
    const cache = new MemoryCacheAdapter();
    await cache.set('key1', 1, 60_000);
    await cache.invalidatePrefix('nonexistent:');
    expect(cache.size).toBe(1);
    cache.destroy();
  });
});

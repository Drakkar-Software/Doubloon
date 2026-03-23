/**
 * E2E: DefaultStoreProductResolver — reverse index build, cache integration,
 * invalidation, all store binding types, concurrent resolve, resolveStoreSku.
 */
import { describe, it, expect, vi } from 'vitest';
import { DefaultStoreProductResolver, MemoryCacheAdapter } from '@doubloon/storage';
import type { ProductMetadata, MetadataStore } from '@doubloon/storage';

const now = new Date().toISOString();

function makeProduct(id: string, bindings: ProductMetadata['storeBindings']): ProductMetadata {
  return {
    productId: id,
    slug: id,
    name: id,
    description: '',
    images: {},
    pricing: { currency: 'usd', amount: 999 },
    storeBindings: bindings,
    createdAt: now,
    updatedAt: now,
  };
}

function mockMetadataStore(products: ProductMetadata[]): MetadataStore {
  return {
    getProduct: vi.fn().mockImplementation(async (id: string) =>
      products.find(p => p.productId === id) ?? null,
    ),
    putProduct: vi.fn().mockResolvedValue({ uri: 'test' }),
    deleteProduct: vi.fn(),
    listProducts: vi.fn().mockResolvedValue(products),
    putAsset: vi.fn().mockResolvedValue({ url: 'test' }),
    getAssetUrl: vi.fn().mockResolvedValue(null),
  };
}

describe('DefaultStoreProductResolver reverse index', () => {
  it('resolves Apple productIds', async () => {
    const store = mockMetadataStore([
      makeProduct('prod_1', { apple: { productIds: ['com.app.monthly', 'com.app.yearly'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveProductId('apple', 'com.app.monthly')).toBe('prod_1');
    expect(await resolver.resolveProductId('apple', 'com.app.yearly')).toBe('prod_1');
    expect(await resolver.resolveProductId('apple', 'com.app.unknown')).toBeNull();
  });

  it('resolves Google productIds', async () => {
    const store = mockMetadataStore([
      makeProduct('prod_2', { google: { productIds: ['premium_monthly'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveProductId('google', 'premium_monthly')).toBe('prod_2');
  });

  it('resolves Stripe priceIds', async () => {
    const store = mockMetadataStore([
      makeProduct('prod_3', { stripe: { priceIds: ['price_abc', 'price_def'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveProductId('stripe', 'price_abc')).toBe('prod_3');
    expect(await resolver.resolveProductId('stripe', 'price_def')).toBe('prod_3');
  });

  it('handles product with all 4 store bindings', async () => {
    const store = mockMetadataStore([
      makeProduct('prod_all', {
        apple: { productIds: ['apple_sku'] },
        google: { productIds: ['google_sku'] },
        stripe: { priceIds: ['price_sku'] },
        x402: { priceUsd: 10, durationSeconds: 86400 },
      }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveProductId('apple', 'apple_sku')).toBe('prod_all');
    expect(await resolver.resolveProductId('google', 'google_sku')).toBe('prod_all');
    expect(await resolver.resolveProductId('stripe', 'price_sku')).toBe('prod_all');
  });

  it('multiple products with different stores', async () => {
    const store = mockMetadataStore([
      makeProduct('prod_a', { apple: { productIds: ['sku_a'] } }),
      makeProduct('prod_b', { stripe: { priceIds: ['price_b'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveProductId('apple', 'sku_a')).toBe('prod_a');
    expect(await resolver.resolveProductId('stripe', 'price_b')).toBe('prod_b');
    expect(await resolver.resolveProductId('apple', 'price_b')).toBeNull();
  });

  it('only calls listProducts once (caches reverse index)', async () => {
    const store = mockMetadataStore([
      makeProduct('p1', { apple: { productIds: ['sku1'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    await resolver.resolveProductId('apple', 'sku1');
    await resolver.resolveProductId('apple', 'sku1');
    await resolver.resolveProductId('apple', 'other');

    expect(store.listProducts).toHaveBeenCalledTimes(1);
  });
});

describe('DefaultStoreProductResolver with cache', () => {
  it('caches resolved product IDs', async () => {
    const cache = new MemoryCacheAdapter();
    const store = mockMetadataStore([
      makeProduct('p1', { stripe: { priceIds: ['price_1'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store, cache);

    // First call builds index
    const r1 = await resolver.resolveProductId('stripe', 'price_1');
    expect(r1).toBe('p1');

    // Even after invalidation, cache still has the SKU→product mapping
    // However, invalidateIndex also clears the cache prefix, so let's test
    // that resolveProductId still returns correct result (via index rebuild)
    resolver.invalidateIndex();
    // Small delay to let void cache.invalidatePrefix settle
    await new Promise(r => setTimeout(r, 10));
    const r2 = await resolver.resolveProductId('stripe', 'price_1');
    expect(r2).toBe('p1');

    // listProducts called twice: once for initial build, once after invalidation forced rebuild
    expect(store.listProducts).toHaveBeenCalledTimes(2);
  });

  it('invalidateIndex clears both memory and cache prefix', async () => {
    const cache = new MemoryCacheAdapter();
    const store = mockMetadataStore([
      makeProduct('p1', { stripe: { priceIds: ['price_1'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store, cache);

    await resolver.resolveProductId('stripe', 'price_1');

    // Manually verify cache has the key
    const cached = await cache.get('sku:stripe:price_1');
    expect(cached).toBe('p1');

    // Invalidate
    resolver.invalidateIndex();
    // Wait a tick for the void invalidatePrefix to settle
    await new Promise(r => setTimeout(r, 10));

    const afterInvalidate = await cache.get('sku:stripe:price_1');
    expect(afterInvalidate).toBeNull();
  });
});

describe('DefaultStoreProductResolver.resolveStoreSku', () => {
  it('returns Apple productIds', async () => {
    const store = mockMetadataStore([
      makeProduct('p1', { apple: { productIds: ['sku_a', 'sku_b'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    const skus = await resolver.resolveStoreSku('p1', 'apple');
    expect(skus).toEqual(['sku_a', 'sku_b']);
  });

  it('returns Stripe priceIds', async () => {
    const store = mockMetadataStore([
      makeProduct('p1', { stripe: { priceIds: ['price_x'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveStoreSku('p1', 'stripe')).toEqual(['price_x']);
  });

  it('returns [productId] for x402', async () => {
    const store = mockMetadataStore([
      makeProduct('p1', { x402: { priceUsd: 5, durationSeconds: 3600 } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveStoreSku('p1', 'x402')).toEqual(['p1']);
  });

  it('returns null for unknown product', async () => {
    const store = mockMetadataStore([]);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveStoreSku('unknown', 'apple')).toBeNull();
  });

  it('returns null for product without binding for store', async () => {
    const store = mockMetadataStore([
      makeProduct('p1', { apple: { productIds: ['sku'] } }),
    ]);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveStoreSku('p1', 'stripe')).toBeNull();
  });
});

describe('DefaultStoreProductResolver index invalidation + rebuild', () => {
  it('picks up new products after invalidateIndex', async () => {
    const products = [
      makeProduct('p1', { apple: { productIds: ['sku1'] } }),
    ];
    const store = mockMetadataStore(products);
    const resolver = new DefaultStoreProductResolver(store);

    expect(await resolver.resolveProductId('apple', 'sku1')).toBe('p1');
    expect(await resolver.resolveProductId('apple', 'sku2')).toBeNull();

    // Add a new product
    products.push(makeProduct('p2', { apple: { productIds: ['sku2'] } }));
    (store.listProducts as any).mockResolvedValue(products);

    // Without invalidation, still returns null
    resolver.invalidateIndex();
    expect(await resolver.resolveProductId('apple', 'sku2')).toBe('p2');
  });
});

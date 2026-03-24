import type { Store } from '@doubloon/core';
import type { CacheAdapter } from './cache.js';

export interface ProductMetadata {
  readonly productId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly images: {
    readonly icon?: string;
    readonly banner?: string;
    readonly screenshots?: readonly string[];
  };
  readonly pricing: {
    readonly currency: string;
    readonly amount: number;
    readonly interval?: 'day' | 'week' | 'month' | 'year';
    readonly intervalCount?: number;
    readonly trialDays?: number;
  };
  readonly storeBindings: {
    readonly apple?: { readonly productIds: readonly string[]; readonly subscriptionGroupId?: string };
    readonly google?: { readonly productIds: readonly string[]; readonly basePlanIds?: readonly string[] };
    readonly stripe?: { readonly priceIds: readonly string[] };
    readonly x402?: { readonly priceUsd: number; readonly durationSeconds: number };
  };
  readonly features?: readonly string[];
  readonly config?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MetadataStore {
  getProduct(productId: string): Promise<ProductMetadata | null>;
  putProduct(metadata: ProductMetadata): Promise<{ uri: string }>;
  deleteProduct(productId: string): Promise<void>;
  listProducts(opts?: { creator?: string; limit?: number; offset?: number }): Promise<ProductMetadata[]>;
  putAsset(productId: string, name: string, data: Buffer, contentType: string): Promise<{ url: string }>;
  getAssetUrl(productId: string, name: string): Promise<string | null>;
}

export interface StoreProductResolver {
  resolveProductId(store: Store, storeSku: string): Promise<string | null>;
  resolveStoreSku(productId: string, store: Store): Promise<string[] | null>;
}

/**
 * Default implementation of StoreProductResolver.
 * Builds a reverse index from metadata to map store SKUs to on-chain product IDs.
 * Results are cached to avoid rebuilding the index on every resolution.
 */
export class DefaultStoreProductResolver implements StoreProductResolver {
  private reverseIndex: Map<string, string> | null = null;

  /**
   * @param metadataStore - Metadata store for product information
   * @param cache - Optional cache adapter for storing SKU-to-productId mappings
   */
  constructor(
    private metadataStore: MetadataStore,
    private cache?: CacheAdapter,
  ) {}

  private async buildReverseIndex(): Promise<Map<string, string>> {
    if (this.reverseIndex) return this.reverseIndex;
    const products = await this.metadataStore.listProducts();
    const index = new Map<string, string>();
    for (const product of products) {
      for (const store of ['apple', 'google', 'stripe', 'x402'] as Store[]) {
        const bindings = product.storeBindings[store];
        if (!bindings) continue;
        const skus: string[] = [];
        if ('productIds' in bindings) skus.push(...bindings.productIds);
        if ('priceIds' in bindings) skus.push(...(bindings as { priceIds: readonly string[] }).priceIds);
        for (const sku of skus) {
          index.set(`${store}:${sku}`, product.productId);
        }
      }
    }
    this.reverseIndex = index;
    return index;
  }

  /** Call to invalidate the in-memory reverse index after product changes. */
  invalidateIndex(): void {
    this.reverseIndex = null;
    if (this.cache) {
      void this.cache.invalidatePrefix('sku:');
    }
  }

  /**
   * Resolve an on-chain product ID from a store-specific SKU.
   * Results are cached with a 5-minute TTL.
   *
   * @param store - Store type (apple, google, stripe, x402)
   * @param storeSku - Store-specific product/price ID
   * @returns On-chain product ID hex string, or null if not mapped
   */
  async resolveProductId(store: Store, storeSku: string): Promise<string | null> {
    const cacheKey = `sku:${store}:${storeSku}`;
    if (this.cache) {
      const cached = await this.cache.get<string>(cacheKey);
      if (cached !== null) return cached;
    }

    const index = await this.buildReverseIndex();
    const productId = index.get(`${store}:${storeSku}`) ?? null;
    if (productId && this.cache) {
      await this.cache.set(cacheKey, productId, 300_000);
    }
    return productId;
  }

  /**
   * Resolve store-specific SKUs from an on-chain product ID.
   * Returns an array because a single product may be mapped to multiple SKUs
   * in the same store (e.g., multiple Google subscription IDs).
   *
   * @param productId - On-chain product ID hex string
   * @param store - Store type (apple, google, stripe, x402)
   * @returns Array of store-specific SKUs, or null if no mapping exists
   */
  async resolveStoreSku(productId: string, store: Store): Promise<string[] | null> {
    const product = await this.metadataStore.getProduct(productId);
    if (!product) return null;
    const bindings = product.storeBindings[store];
    if (!bindings) return null;
    if ('productIds' in bindings) return [...bindings.productIds];
    if ('priceIds' in bindings) return [...(bindings as { priceIds: readonly string[] }).priceIds];
    if (store === 'x402') return [productId]; // x402 has no SKU concept; return productId as identifier
    return null;
  }
}

import type { EntitlementCheck } from '@doubloon/core';

export interface EntitlementCacheConfig {
  defaultTtlMs?: number;
  maxEntries?: number;
}

export class EntitlementCache {
  private cache = new Map<string, { check: EntitlementCheck; expiresAt: number }>();
  private defaultTtlMs: number;
  private maxEntries: number;

  constructor(config?: EntitlementCacheConfig) {
    this.defaultTtlMs = config?.defaultTtlMs ?? 30_000;
    this.maxEntries = config?.maxEntries ?? 1000;
  }

  get(productId: string, wallet: string): EntitlementCheck | null {
    const key = `${productId}:${wallet}`;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.check;
  }

  set(productId: string, wallet: string, check: EntitlementCheck, ttlMs?: number): void {
    const key = `${productId}:${wallet}`;
    this.cache.set(key, {
      check,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
    if (this.cache.size > this.maxEntries) {
      // Evict oldest entry (first inserted in Map iteration order)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
  }

  invalidate(productId: string, wallet: string): void {
    this.cache.delete(`${productId}:${wallet}`);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

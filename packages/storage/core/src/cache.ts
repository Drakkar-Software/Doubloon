/**
 * Generic key-value cache with TTL.
 */
export interface CacheAdapter {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlMs: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  invalidatePrefix(prefix: string): Promise<void>;
}

/**
 * In-memory cache with TTL. Ships with @doubloon/storage (zero deps).
 *
 * Features:
 * - Automatic TTL-based expiration
 * - LRU-style eviction when maxEntries is exceeded
 * - Background cleanup timer to purge expired entries
 * - Configurable cleanup interval and max capacity
 */
export class MemoryCacheAdapter implements CacheAdapter {
  private store = new Map<string, { value: unknown; expiresAt: number }>();
  private cleanupIntervalMs: number;
  private maxEntries: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(opts?: { cleanupIntervalMs?: number; maxEntries?: number }) {
    this.cleanupIntervalMs = opts?.cleanupIntervalMs ?? 60_000;
    this.maxEntries = opts?.maxEntries ?? 10_000;
    this.startCleanup();
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    // Evict oldest if at capacity
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async invalidate(key: string): Promise<void> {
    this.store.delete(key);
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  get size(): number {
    return this.store.size;
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (entry.expiresAt < now) this.store.delete(key);
      }
    }, this.cleanupIntervalMs);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }
}

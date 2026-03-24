/**
 * Deduplication store interface and in-memory default.
 *
 * Used by the server to prevent processing the same webhook notification twice.
 */

export interface DedupStore {
  isDuplicate(key: string): Promise<boolean>;
  markProcessed(key: string): Promise<void>;
  clearProcessed(key: string): Promise<void>;
  /**
   * Atomically check whether a key is a duplicate AND mark it as processed if not.
   * Returns true if the key was already processed (duplicate), false if newly marked.
   *
   * This avoids the race condition where two concurrent calls to isDuplicate()
   * both return false before either calls markProcessed().
   *
   * Implementations backed by Redis should use SET NX or a Lua script.
   * The default in-memory implementation is atomic within a single process.
   */
  checkAndMark?(key: string): Promise<boolean>;
}

/**
 * In-memory dedup store with TTL-based auto-cleanup.
 * Suitable for single-process deployments. For multi-instance,
 * use a Redis or Postgres-backed implementation.
 *
 * Runs a background cleanup timer that removes expired entries every 60 seconds.
 * Automatically evicts the oldest entry when capacity is reached (default: 100k entries).
 *
 * @example
 * const dedup = new MemoryDedupStore({ ttlMs: 24 * 60 * 60 * 1000 });
 * const isDup = await dedup.checkAndMark(key);
 */
export class MemoryDedupStore implements DedupStore {
  private processed = new Map<string, number>();
  private ttlMs: number;
  private maxEntries: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this.maxEntries = opts?.maxEntries ?? 100_000;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, expiresAt] of this.processed) {
        if (expiresAt < now) this.processed.delete(key);
      }
    }, 60_000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  async isDuplicate(key: string): Promise<boolean> {
    const expiresAt = this.processed.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt < Date.now()) {
      this.processed.delete(key);
      return false;
    }
    return true;
  }

  async markProcessed(key: string): Promise<void> {
    // Evict oldest if at capacity
    if (this.processed.size >= this.maxEntries && !this.processed.has(key)) {
      const firstKey = this.processed.keys().next().value;
      if (firstKey !== undefined) this.processed.delete(firstKey);
    }
    this.processed.set(key, Date.now() + this.ttlMs);
  }

  /**
   * Atomically check-and-mark: returns true if already processed (duplicate),
   * false if newly marked. Single-process safe because JS is single-threaded
   * and this method has no await between the check and the set.
   *
   * @param key - Deduplication key (e.g., notification ID)
   * @returns true if key was already marked, false if newly marked
   */
  async checkAndMark(key: string): Promise<boolean> {
    const expiresAt = this.processed.get(key);
    if (expiresAt !== undefined && expiresAt >= Date.now()) {
      return true; // duplicate
    }
    // Not a duplicate — mark it now (atomically, no await gap)
    if (this.processed.size >= this.maxEntries && !this.processed.has(key)) {
      const firstKey = this.processed.keys().next().value;
      if (firstKey !== undefined) this.processed.delete(firstKey);
    }
    this.processed.set(key, Date.now() + this.ttlMs);
    return false;
  }

  async clearProcessed(key: string): Promise<void> {
    this.processed.delete(key);
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  get size(): number {
    return this.processed.size;
  }
}

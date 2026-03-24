/**
 * Sliding window rate limiter with pluggable storage.
 *
 * Ships with an in-memory implementation by default.
 */

export interface RateLimiterStore {
  /**
   * Atomically record a hit and return the current count within the window.
   *
   * Implementations MUST be atomic: the read-increment-return must happen
   * as a single operation with no interleaving. For Redis, use INCR + PEXPIRE
   * in a pipeline or Lua script. The in-memory default is naturally atomic
   * because JS is single-threaded and this method has no await gaps.
   */
  hit(key: string, windowMs: number): Promise<number>;
}

export interface RateLimiterConfig {
  /** Maximum requests per window. Default: 60 */
  maxRequests?: number;
  /** Window duration in ms. Default: 60_000 (1 minute) */
  windowMs?: number;
  /** Optional custom store. Defaults to in-memory. */
  store?: RateLimiterStore;
  /** Key extractor. Receives the request and returns a rate limit key (e.g., IP). */
  keyExtractor?: (req: { headers: Record<string, string> }) => string;
  /**
   * Whether the server sits behind a trusted reverse proxy.
   * When `true`, x-forwarded-for and x-real-ip headers are trusted for IP extraction.
   * When `false` (default), proxy headers are ignored and the rate limiter uses
   * a generic key — you should provide a custom `keyExtractor` that uses the
   * socket remote address from your HTTP framework.
   *
   * WARNING: Setting this to `true` without a trusted proxy in front allows
   * clients to spoof their IP and bypass rate limiting entirely.
   */
  trustProxy?: boolean;
}

export interface RateLimiter {
  /** Returns true if the request is allowed, false if rate-limited. */
  check(req: { headers: Record<string, string> }): Promise<boolean>;
}

/**
 * In-memory sliding-window rate limiter store.
 */
export class MemoryRateLimiterStore implements RateLimiterStore {
  private windows = new Map<string, { count: number; expiresAt: number }>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.windows) {
        if (entry.expiresAt < now) this.windows.delete(key);
      }
    }, 60_000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  async hit(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (existing && existing.expiresAt > now) {
      existing.count++;
      return existing.count;
    }

    this.windows.set(key, { count: 1, expiresAt: now + windowMs });
    return 1;
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

/**
 * Create a rate limiter from config.
 * Defaults to 60 requests per minute with in-memory storage.
 *
 * @param config - Optional configuration with max requests, window duration, and custom storage
 * @returns A rate limiter that checks whether requests should be allowed
 */
export function createRateLimiter(config?: RateLimiterConfig): RateLimiter {
  const maxRequests = config?.maxRequests ?? 60;
  const windowMs = config?.windowMs ?? 60_000;
  const store = config?.store ?? new MemoryRateLimiterStore();
  const trustProxy = config?.trustProxy ?? false;
  const keyExtractor = config?.keyExtractor ?? ((req: { headers: Record<string, string> }) => defaultKeyExtractor(req, trustProxy));

  return {
    async check(req: { headers: Record<string, string> }): Promise<boolean> {
      const key = keyExtractor(req);
      const count = await store.hit(key, windowMs);
      return count <= maxRequests;
    },
  };
}

function defaultKeyExtractor(req: { headers: Record<string, string> }, trustProxy: boolean): string {
  if (trustProxy) {
    // Only trust proxy headers when explicitly configured — prevents IP spoofing
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return `rl:${forwarded.split(',')[0].trim()}`;
    const realIp = req.headers['x-real-ip'];
    if (realIp) return `rl:${realIp}`;
  }
  // Without a trusted proxy, we can't reliably extract the client IP from headers.
  // Fall back to a generic key. For per-IP limiting, provide a custom keyExtractor
  // that uses req.socket.remoteAddress from your HTTP framework.
  return 'rl:unknown';
}

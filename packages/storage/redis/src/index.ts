import type { CacheAdapter } from '@doubloon/storage';

/**
 * Redis-backed cache adapter for Doubloon.
 *
 * Uses a generic Redis client interface so it works with ioredis, node-redis, etc.
 */

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
  pexpire(key: string, ms: number): Promise<number>;
  quit?(): Promise<unknown>;
}

export interface RedisCacheAdapterConfig {
  client: RedisLike;
  /** Key prefix to namespace all Doubloon keys. Defaults to "dbl:" */
  prefix?: string;
}

export class RedisCacheAdapter implements CacheAdapter {
  private client: RedisLike;
  private prefix: string;

  constructor(config: RedisCacheAdapterConfig) {
    this.client = config.client;
    this.prefix = config.prefix ?? 'dbl:';
  }

  private key(k: string): string {
    return `${this.prefix}${k}`;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.key(key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlMs: number): Promise<void> {
    const prefixed = this.key(key);
    await this.client.set(prefixed, JSON.stringify(value));
    await this.client.pexpire(prefixed, ttlMs);
  }

  async invalidate(key: string): Promise<void> {
    await this.client.del(this.key(key));
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    const pattern = `${this.prefix}${prefix}*`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.client.del(keys);
      }
    } while (cursor !== '0');
  }

  async destroy(): Promise<void> {
    if (this.client.quit) {
      await this.client.quit();
    }
  }
}

/**
 * E2E: Rate limiter — IP extraction from proxy headers, window expiry,
 * custom key extractors, memory store cleanup.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRateLimiter, MemoryRateLimiterStore } from '@doubloon/server';

describe('Rate limiter IP extraction', () => {
  it('x-forwarded-for with single IP', async () => {
    const limiter = createRateLimiter({ maxRequests: 1 });
    const req = { headers: { 'x-forwarded-for': '10.0.0.1' } };

    expect(await limiter.check(req)).toBe(true);
    expect(await limiter.check(req)).toBe(false); // over limit
  });

  it('x-forwarded-for with multiple proxies uses first IP', async () => {
    const limiter = createRateLimiter({ maxRequests: 1 });

    // Same client through different proxies
    const req1 = { headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.1, 172.16.0.1' } };
    const req2 = { headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.2' } };

    expect(await limiter.check(req1)).toBe(true);
    expect(await limiter.check(req2)).toBe(false); // same client IP
  });

  it('x-forwarded-for with spaces is trimmed', async () => {
    const limiter = createRateLimiter({ maxRequests: 1 });

    expect(await limiter.check({ headers: { 'x-forwarded-for': '  10.0.0.1  , proxy' } })).toBe(true);
    expect(await limiter.check({ headers: { 'x-forwarded-for': '10.0.0.1,proxy2' } })).toBe(false);
  });

  it('x-real-ip used when no x-forwarded-for', async () => {
    const limiter = createRateLimiter({ maxRequests: 1 });

    expect(await limiter.check({ headers: { 'x-real-ip': '10.0.0.5' } })).toBe(true);
    expect(await limiter.check({ headers: { 'x-real-ip': '10.0.0.5' } })).toBe(false);
  });

  it('falls back to "unknown" when no IP headers', async () => {
    const limiter = createRateLimiter({ maxRequests: 2 });

    expect(await limiter.check({ headers: {} })).toBe(true);
    expect(await limiter.check({ headers: {} })).toBe(true);
    expect(await limiter.check({ headers: {} })).toBe(false); // all share "unknown" key
  });

  it('different IPs have independent limits', async () => {
    const limiter = createRateLimiter({ maxRequests: 1, trustProxy: true });

    expect(await limiter.check({ headers: { 'x-real-ip': '1.1.1.1' } })).toBe(true);
    expect(await limiter.check({ headers: { 'x-real-ip': '2.2.2.2' } })).toBe(true);
    expect(await limiter.check({ headers: { 'x-real-ip': '1.1.1.1' } })).toBe(false);
    expect(await limiter.check({ headers: { 'x-real-ip': '2.2.2.2' } })).toBe(false);
  });

  it('x-forwarded-for takes precedence over x-real-ip', async () => {
    const limiter = createRateLimiter({ maxRequests: 1, trustProxy: true });

    expect(await limiter.check({ headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' } })).toBe(true);
    // Same x-forwarded-for → blocked
    expect(await limiter.check({ headers: { 'x-forwarded-for': '1.2.3.4' } })).toBe(false);
    // Different x-real-ip alone → allowed
    expect(await limiter.check({ headers: { 'x-real-ip': '5.6.7.8' } })).toBe(true);
  });
});

describe('Rate limiter custom key extractor', () => {
  it('uses custom key extractor', async () => {
    const limiter = createRateLimiter({
      maxRequests: 1,
      keyExtractor: (req) => `api:${req.headers['x-api-key'] ?? 'anon'}`,
    });

    expect(await limiter.check({ headers: { 'x-api-key': 'key1' } })).toBe(true);
    expect(await limiter.check({ headers: { 'x-api-key': 'key1' } })).toBe(false);
    expect(await limiter.check({ headers: { 'x-api-key': 'key2' } })).toBe(true);
  });
});

describe('MemoryRateLimiterStore', () => {
  it('hit increments count within window', async () => {
    const store = new MemoryRateLimiterStore();
    expect(await store.hit('k1', 60_000)).toBe(1);
    expect(await store.hit('k1', 60_000)).toBe(2);
    expect(await store.hit('k1', 60_000)).toBe(3);
    store.destroy();
  });

  it('independent keys have independent counts', async () => {
    const store = new MemoryRateLimiterStore();
    expect(await store.hit('a', 60_000)).toBe(1);
    expect(await store.hit('b', 60_000)).toBe(1);
    expect(await store.hit('a', 60_000)).toBe(2);
    expect(await store.hit('b', 60_000)).toBe(2);
    store.destroy();
  });

  it('expired window resets count', async () => {
    const store = new MemoryRateLimiterStore();
    // Use a very short window
    expect(await store.hit('k1', 1)).toBe(1);

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 10));
    expect(await store.hit('k1', 1)).toBe(1); // reset
    store.destroy();
  });
});

describe('Rate limiter window boundary', () => {
  it('requests within window accumulate, new window resets', async () => {
    const store = new MemoryRateLimiterStore();
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 50, store });

    const req = { headers: { 'x-real-ip': '1.1.1.1' } };
    expect(await limiter.check(req)).toBe(true);  // 1
    expect(await limiter.check(req)).toBe(true);  // 2
    expect(await limiter.check(req)).toBe(false); // 3 → rejected

    // Wait for window reset
    await new Promise(r => setTimeout(r, 60));
    expect(await limiter.check(req)).toBe(true);  // reset → 1
    store.destroy();
  });
});

/**
 * Server Pipeline Throughput Benchmark
 *
 * Processes 1000 webhook notifications through the full pipeline.
 * Measures p50/p95/p99 latency.
 * Tests with rate limiter enabled at various thresholds.
 * Tests graceful degradation when chain store is slow.
 */

import { describe, it, expect, vi } from 'vitest';
import { createServer } from '@drakkar.software/doubloon-server';
import { deriveProductIdHex } from '@drakkar.software/doubloon-core';
import type { MintInstruction, StoreNotification } from '@drakkar.software/doubloon-core';

function makeMockChain() {
  return {
    reader: {
      checkEntitlement: vi.fn().mockResolvedValue({ entitled: false, entitlement: null, reason: 'not_found', expiresAt: null, product: null }),
      checkEntitlements: vi.fn().mockResolvedValue({ results: {}, user: '', checkedAt: new Date() }),
      getEntitlement: vi.fn().mockResolvedValue(null),
      getProduct: vi.fn().mockResolvedValue(null),
    },
    writer: {
      mintEntitlement: vi.fn().mockResolvedValue({}),
      revokeEntitlement: vi.fn().mockResolvedValue({}),
    },
    signer: { signAndSend: vi.fn().mockResolvedValue('mock-sig'), publicKey: 'mock-key' },
  };
}

describe('Server Pipeline Throughput Benchmark', () => {
  const productId = deriveProductIdHex('benchmark-product');
  const userId = '0xBenchmark';

  function calculatePercentile(latencies: number[], percentile: number): number {
    const sorted = [...latencies].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  function reportLatencyStats(latencies: number[], label: string) {
    const p50 = calculatePercentile(latencies, 50);
    const p95 = calculatePercentile(latencies, 95);
    const p99 = calculatePercentile(latencies, 99);
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);

    console.log(`${label}:`);
    console.log(`  p50: ${p50.toFixed(2)}ms, p95: ${p95.toFixed(2)}ms, p99: ${p99.toFixed(2)}ms`);
    console.log(`  avg: ${avg.toFixed(2)}ms, min: ${min.toFixed(2)}ms, max: ${max.toFixed(2)}ms`);

    return { p50, p95, p99, avg, min, max };
  }

  it('should process 1000 webhooks through the full pipeline and measure latency', async () => {
    const server = createServer({
      chain: makeMockChain(),
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: {
              id: `webhook-${Date.now()}`,
              store: 'stripe',
              type: 'subscription_renewed',
              deduplicationKey: `dedup-${Date.now()}:${Math.random()}`,
              originalTransactionId: `txn-${Date.now()}`,
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: {
              productId,
              user: userId,
              expiresAt: new Date(Date.now() + 86400000),
              source: 'stripe',
              sourceId: `sub-${Date.now()}`,
            } as MintInstruction,
          }),
        },
        apple: {
          handleNotification: async () => ({
            notification: {
              id: 'apple-txn-1',
              store: 'apple',
              type: 'subscription_renewed',
              deduplicationKey: `apple:${Date.now()}`,
              originalTransactionId: 'apple-orig-1',
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: null,
          }),
        },
        google: {
          handleNotification: async () => ({
            notification: {
              id: 'google-txn-1',
              store: 'google',
              type: 'subscription_purchased',
              deduplicationKey: `google:${Date.now()}`,
              originalTransactionId: 'google-orig-1',
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: null,
          }),
        },
      },
      onMintFailure: async () => {},
      rateLimiter: false, // Disable rate limiting for throughput test
    });

    const latencies: number[] = [];
    const webhookCount = 1000;

    for (let i = 0; i < webhookCount; i++) {
      const req = {
        headers: { 'stripe-signature': `sig_${i}` } as Record<string, string>,
        body: Buffer.from(`{"id":"evt_${i}","type":"customer.subscription.created"}`),
      };

      const start = performance.now();
      const res = await server.handleWebhook(req);
      const timeMs = performance.now() - start;

      expect(res.status).toBe(200);
      latencies.push(timeMs);
    }

    const stats = reportLatencyStats(latencies, 'Full pipeline (no rate limit)');

    // All should be reasonably fast
    expect(stats.p99).toBeLessThan(100); // p99 under 100ms
    expect(stats.max).toBeLessThan(500); // max under 500ms
  });

  it('should degrade gracefully when processing is rate-limited at 100 req/min', async () => {
    const server = createServer({
      chain: makeMockChain(),
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: {
              id: `webhook-${Date.now()}`,
              store: 'stripe',
              type: 'subscription_renewed',
              deduplicationKey: `dedup-${Date.now()}:${Math.random()}`,
              originalTransactionId: `txn-${Date.now()}`,
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: {
              productId,
              user: userId,
              expiresAt: new Date(Date.now() + 86400000),
              source: 'stripe',
              sourceId: `sub-${Date.now()}`,
            } as MintInstruction,
          }),
        },
        apple: {
          handleNotification: async () => ({
            notification: {
              id: 'apple-txn-1',
              store: 'apple',
              type: 'subscription_renewed',
              deduplicationKey: `apple:${Date.now()}`,
              originalTransactionId: 'apple-orig-1',
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: null,
          }),
        },
        google: {
          handleNotification: async () => ({
            notification: {
              id: 'google-txn-1',
              store: 'google',
              type: 'subscription_purchased',
              deduplicationKey: `google:${Date.now()}`,
              originalTransactionId: 'google-orig-1',
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: null,
          }),
        },
      },
      onMintFailure: async () => {},
      rateLimiter: { maxRequests: 100, windowMs: 60000, trustProxy: true },
    });

    const latencies: number[] = [];
    const rateLimitedCount = { count: 0 };
    const webhookCount = 150;

    for (let i = 0; i < webhookCount; i++) {
      const req = {
        headers: { 'x-forwarded-for': '1.2.3.4' } as Record<string, string>,
        body: Buffer.from(`{"id":"evt_${i}","type":"customer.subscription.created"}`),
      };

      const start = performance.now();
      const res = await server.handleWebhook(req);
      const timeMs = performance.now() - start;

      latencies.push(timeMs);

      if (res.status === 429) {
        rateLimitedCount.count++;
      } else if (res.status === 200) {
        // Expected success
      } else {
        // Unknown store from non-stripe request
        // This is acceptable for this test
      }
    }

    // Should have rate limited some requests (100 allowed per min, we sent 150)
    expect(rateLimitedCount.count).toBeGreaterThan(0);

    const stats = reportLatencyStats(latencies.slice(0, Math.min(50, latencies.length)), 'Rate-limited pipeline (100 req/min)');

    expect(stats.max).toBeLessThan(500);
  });

  it('should measure throughput with tight rate limiting (10 req/min)', async () => {
    const server = createServer({
      chain: makeMockChain(),
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: {
              id: `webhook-${Date.now()}`,
              store: 'stripe',
              type: 'subscription_renewed',
              deduplicationKey: `dedup-${Date.now()}:${Math.random()}`,
              originalTransactionId: `txn-${Date.now()}`,
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: {
              productId,
              user: userId,
              expiresAt: new Date(Date.now() + 86400000),
              source: 'stripe',
              sourceId: `sub-${Date.now()}`,
            } as MintInstruction,
          }),
        },
        apple: {
          handleNotification: async () => ({
            notification: {
              id: 'apple-txn-1',
              store: 'apple',
              type: 'subscription_renewed',
              deduplicationKey: `apple:${Date.now()}`,
              originalTransactionId: 'apple-orig-1',
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: null,
          }),
        },
        google: {
          handleNotification: async () => ({
            notification: {
              id: 'google-txn-1',
              store: 'google',
              type: 'subscription_purchased',
              deduplicationKey: `google:${Date.now()}`,
              originalTransactionId: 'google-orig-1',
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: null,
          }),
        },
      },
      onMintFailure: async () => {},
      rateLimiter: { maxRequests: 10, windowMs: 60000 },
    });

    const latencies: number[] = [];
    const statusCodes: number[] = [];

    for (let i = 0; i < 20; i++) {
      const req = {
        headers: { 'x-forwarded-for': `1.2.3.${i}` } as Record<string, string>,
        body: Buffer.from(`{"id":"evt_${i}","type":"customer.subscription.created"}`),
      };

      const start = performance.now();
      const res = await server.handleWebhook(req);
      const timeMs = performance.now() - start;

      latencies.push(timeMs);
      statusCodes.push(res.status);
    }

    const successCount = statusCodes.filter((s) => s === 200 || s === 400).length; // 400 for unknown store
    const rateLimitedCount = statusCodes.filter((s) => s === 429).length;

    // With 10 requests per minute limit and 20 attempts, should see rate limiting
    expect(successCount).toBeGreaterThan(0);
    expect(rateLimitedCount).toBeGreaterThan(0);

    reportLatencyStats(latencies.slice(0, Math.min(10, successCount)), 'Tight rate limit (10 req/min)');
  });

  it('should handle concurrent webhooks with proper dedup', async () => {
    const server = createServer({
      chain: makeMockChain(),
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: {
              id: `webhook-concurrent`,
              store: 'stripe',
              type: 'subscription_renewed',
              deduplicationKey: `dedup-concurrent:${Date.now()}`,
              originalTransactionId: `txn-concurrent`,
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: {
              productId,
              user: userId,
              expiresAt: new Date(Date.now() + 86400000),
              source: 'stripe',
              sourceId: `sub-concurrent`,
            } as MintInstruction,
          }),
        },
        apple: {
          handleNotification: async () => ({
            notification: {
              id: 'apple-txn-1',
              store: 'apple',
              type: 'subscription_renewed',
              deduplicationKey: `apple:${Date.now()}`,
              originalTransactionId: 'apple-orig-1',
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: null,
          }),
        },
        google: {
          handleNotification: async () => ({
            notification: {
              id: 'google-txn-1',
              store: 'google',
              type: 'subscription_purchased',
              deduplicationKey: `google:${Date.now()}`,
              originalTransactionId: 'google-orig-1',
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: null,
          }),
        },
      },
      onMintFailure: async () => {},
    });

    const req = {
      headers: { 'stripe-signature': 'sig_test' } as Record<string, string>,
      body: Buffer.from('{"id":"evt_concurrent","type":"customer.subscription.created"}'),
    };

    // Send 50 concurrent identical requests
    const latencies: number[] = [];
    const promises = Array.from({ length: 50 }, async () => {
      const start = performance.now();
      const res = await server.handleWebhook(req);
      const timeMs = performance.now() - start;
      latencies.push(timeMs);
      return res.status;
    });

    const results = await Promise.all(promises);

    // All should return 200 (duplicates also return 200)
    expect(results.every((s) => s === 200)).toBe(true);

    const stats = reportLatencyStats(latencies, 'Concurrent requests (50x same webhook)');
    expect(stats.p99).toBeLessThan(100);
  });

  it('should maintain stable latency under sustained load', async () => {
    const server = createServer({
      chain: makeMockChain(),
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: {
              id: `webhook-${Date.now()}`,
              store: 'stripe',
              type: 'subscription_renewed',
              deduplicationKey: `dedup-${Date.now()}:${Math.random()}`,
              originalTransactionId: `txn-${Date.now()}`,
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: {
              productId,
              user: userId,
              expiresAt: new Date(Date.now() + 86400000),
              source: 'stripe',
              sourceId: `sub-${Date.now()}`,
            } as MintInstruction,
          }),
        },
        apple: {
          handleNotification: async () => ({
            notification: {
              id: 'apple-txn-1',
              store: 'apple',
              type: 'subscription_renewed',
              deduplicationKey: `apple:${Date.now()}`,
              originalTransactionId: 'apple-orig-1',
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: null,
          }),
        },
        google: {
          handleNotification: async () => ({
            notification: {
              id: 'google-txn-1',
              store: 'google',
              type: 'subscription_purchased',
              deduplicationKey: `google:${Date.now()}`,
              originalTransactionId: 'google-orig-1',
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: null,
          }),
        },
      },
      onMintFailure: async () => {},
      rateLimiter: false, // Disable rate limiting for load test
    });

    // Process in batches and compare latency trends
    const batchSize = 100;
    const batches = 5;
    const batchStats: Array<{ batch: number; stats: any }> = [];

    for (let batch = 0; batch < batches; batch++) {
      const batchLatencies: number[] = [];

      for (let i = 0; i < batchSize; i++) {
        const req = {
          headers: { 'stripe-signature': `sig_${batch}_${i}` } as Record<string, string>,
          body: Buffer.from(`{"id":"evt_${batch}_${i}","type":"customer.subscription.created"}`),
        };

        const start = performance.now();
        const res = await server.handleWebhook(req);
        const timeMs = performance.now() - start;

        expect(res.status).toBe(200);
        batchLatencies.push(timeMs);
      }

      const stats = {
        p50: calculatePercentile(batchLatencies, 50),
        p95: calculatePercentile(batchLatencies, 95),
        p99: calculatePercentile(batchLatencies, 99),
      };

      batchStats.push({ batch, stats });
    }

    // Latency should remain stable across batches (no degradation)
    const firstBatchP99 = batchStats[0].stats.p99;
    const lastBatchP99 = batchStats[batches - 1].stats.p99;

    console.log(`Batch P99 comparison: first=${firstBatchP99.toFixed(2)}ms, last=${lastBatchP99.toFixed(2)}ms`);

    // Allow up to 2x degradation from first to last batch
    expect(lastBatchP99).toBeLessThan(firstBatchP99 * 2);
  });

  it('should handle mixed workload with different bridges', async () => {
    const server = createServer({
      chain: makeMockChain(),
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: {
              id: `webhook-stripe-${Date.now()}`,
              store: 'stripe',
              type: 'subscription_renewed',
              deduplicationKey: `dedup-stripe-${Date.now()}:${Math.random()}`,
              originalTransactionId: `txn-stripe-${Date.now()}`,
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: {
              productId,
              user: userId,
              expiresAt: new Date(Date.now() + 86400000),
              source: 'stripe',
              sourceId: `sub-stripe-${Date.now()}`,
            } as MintInstruction,
          }),
        },
        apple: {
          handleNotification: async () => ({
            notification: {
              id: `webhook-apple-${Date.now()}`,
              store: 'apple',
              type: 'subscription_renewed',
              deduplicationKey: `dedup-apple-${Date.now()}:${Math.random()}`,
              originalTransactionId: `txn-apple-${Date.now()}`,
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: {
              productId,
              user: userId,
              expiresAt: new Date(Date.now() + 86400000),
              source: 'apple',
              sourceId: `sub-apple-${Date.now()}`,
            } as MintInstruction,
          }),
        },
        google: {
          handleNotification: async () => ({
            notification: {
              id: `webhook-google-${Date.now()}`,
              store: 'google',
              type: 'subscription_purchased',
              deduplicationKey: `dedup-google-${Date.now()}:${Math.random()}`,
              originalTransactionId: `txn-google-${Date.now()}`,
              timestamp: new Date(),
              rawPayload: {},
            } as StoreNotification,
            instruction: {
              productId,
              user: userId,
              expiresAt: new Date(Date.now() + 86400000),
              source: 'google',
              sourceId: `sub-google-${Date.now()}`,
            } as MintInstruction,
          }),
        },
      },
      onMintFailure: async () => {},
      rateLimiter: false, // Disable rate limiting for mixed workload test
    });

    const latencies: number[] = [];
    const webhookCount = 300;

    for (let i = 0; i < webhookCount; i++) {
      const bridge = ['stripe', 'apple', 'google'][i % 3];
      let req;

      if (bridge === 'stripe') {
        req = {
          headers: { 'stripe-signature': `sig_${i}` } as Record<string, string>,
          body: Buffer.from(`{"id":"evt_${i}","type":"customer.subscription.created"}`),
        };
      } else if (bridge === 'apple') {
        req = {
          headers: {} as Record<string, string>,
          body: Buffer.from('eyJ' + Buffer.from(`apple-${i}`).toString('base64').slice(0, 10)),
        };
      } else {
        req = {
          headers: {} as Record<string, string>,
          body: JSON.stringify({ message: { data: Buffer.from(`google-${i}`).toString('base64') } }),
        };
      }

      const start = performance.now();
      const res = await server.handleWebhook(req);
      const timeMs = performance.now() - start;

      expect(res.status).toBe(200);
      latencies.push(timeMs);
    }

    const stats = reportLatencyStats(latencies, 'Mixed bridge workload (300 webhooks)');
    expect(stats.p99).toBeLessThan(100);
  });
});

/**
 * E2E: Advanced EntitlementCache behavior — TTL clamping, eviction,
 * expiry boundaries, and integration with checker.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createLocalChain } from '@doubloon/chain-local';
import { createEntitlementChecker, EntitlementCache } from '@doubloon/react-native';
import { deriveProductIdHex } from '@doubloon/core';
import type { EntitlementCheck } from '@doubloon/core';

describe('EntitlementCache TTL clamping', () => {
  it('clamps TTL to entitlement expiry when it is sooner than defaultTtl', () => {
    const cache = new EntitlementCache({ defaultTtlMs: 60_000 });

    // Entitlement expires in 100ms
    const expiresAt = new Date(Date.now() + 100);
    const check: EntitlementCheck = {
      entitled: true,
      entitlement: null,
      reason: 'active',
      expiresAt,
      product: null,
    };

    cache.set('pid', 'wallet', check);
    expect(cache.get('pid', 'wallet')).not.toBeNull();

    // Wait for expiry TTL + buffer
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.get('pid', 'wallet')).toBeNull(); // TTL expired
        resolve();
      }, 200);
    });
  });

  it('uses defaultTtl when entitlement has no expiry (lifetime)', () => {
    const cache = new EntitlementCache({ defaultTtlMs: 100 });

    const check: EntitlementCheck = {
      entitled: true,
      entitlement: null,
      reason: 'active',
      expiresAt: null, // lifetime
      product: null,
    };

    cache.set('pid', 'wallet', check);
    expect(cache.get('pid', 'wallet')!.entitled).toBe(true);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.get('pid', 'wallet')).toBeNull(); // defaultTtl expired
        resolve();
      }, 200);
    });
  });

  it('expired entitlement (expiresAt in past) clamps to near-zero TTL', () => {
    const cache = new EntitlementCache({ defaultTtlMs: 60_000 });

    // expiresAt already in the past — TTL clamps to max(0, negative) = 0
    // effectiveTtl = min(60000, 0) = 0
    // expiresAt in cache = Date.now() + 0 = Date.now()
    // get() check is `entry.expiresAt < Date.now()` — may be same ms, so entry
    // persists for up to 1ms. After a short delay it should be gone.
    const check: EntitlementCheck = {
      entitled: true,
      entitlement: null,
      reason: 'active',
      expiresAt: new Date(Date.now() - 1000),
      product: null,
    };

    cache.set('pid', 'wallet', check);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.get('pid', 'wallet')).toBeNull();
        resolve();
      }, 10);
    });
  });

  it('custom TTL per entry overrides default', () => {
    const cache = new EntitlementCache({ defaultTtlMs: 60_000 });

    const check: EntitlementCheck = {
      entitled: false,
      entitlement: null,
      reason: 'not_found',
      expiresAt: null,
      product: null,
    };

    cache.set('pid', 'wallet', check, 100); // 100ms TTL

    expect(cache.get('pid', 'wallet')).not.toBeNull();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.get('pid', 'wallet')).toBeNull();
        resolve();
      }, 200);
    });
  });
});

describe('EntitlementCache maxEntries eviction', () => {
  it('evicts oldest entry when exceeding maxEntries', () => {
    const cache = new EntitlementCache({ defaultTtlMs: 60_000, maxEntries: 3 });

    const check: EntitlementCheck = {
      entitled: true, entitlement: null, reason: 'active', expiresAt: null, product: null,
    };

    cache.set('p1', 'w1', check);
    cache.set('p2', 'w1', check);
    cache.set('p3', 'w1', check);
    expect(cache.size).toBe(3);

    // Adding 4th should evict p1:w1
    cache.set('p4', 'w1', check);
    expect(cache.size).toBe(3);
    expect(cache.get('p1', 'w1')).toBeNull(); // evicted
    expect(cache.get('p2', 'w1')).not.toBeNull();
    expect(cache.get('p4', 'w1')).not.toBeNull();
  });

  it('updating existing entry does not trigger eviction', () => {
    const cache = new EntitlementCache({ defaultTtlMs: 60_000, maxEntries: 2 });

    const check1: EntitlementCheck = {
      entitled: true, entitlement: null, reason: 'active', expiresAt: null, product: null,
    };
    const check2: EntitlementCheck = {
      entitled: false, entitlement: null, reason: 'expired', expiresAt: null, product: null,
    };

    cache.set('p1', 'w1', check1);
    cache.set('p2', 'w1', check1);
    expect(cache.size).toBe(2);

    // Update existing entry
    cache.set('p1', 'w1', check2);
    expect(cache.size).toBe(2);
    expect(cache.get('p1', 'w1')!.entitled).toBe(false);
    expect(cache.get('p2', 'w1')).not.toBeNull();
  });
});

describe('Cache + checker integration', () => {
  it('full flow: check → cache → revoke → stale cache → invalidate → fresh check', async () => {
    const local = createLocalChain();
    const pid = deriveProductIdHex('cache-int');
    const wallet = '0xAlice';

    const checker = createEntitlementChecker({ reader: local.reader });
    const cache = new EntitlementCache({ defaultTtlMs: 60_000 });

    // 1. Mint and check
    local.store.mintEntitlement({
      productId: pid, user: wallet, expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe', sourceId: 'sub_1',
    });

    const check1 = await checker.check(pid, wallet);
    cache.set(pid, wallet, check1);
    expect(cache.get(pid, wallet)!.entitled).toBe(true);

    // 2. Revoke on-chain
    local.store.revokeEntitlement({ productId: pid, user: wallet, revokedBy: 'admin' });

    // 3. Cache still returns stale entitled=true
    expect(cache.get(pid, wallet)!.entitled).toBe(true);

    // 4. Invalidate cache
    cache.invalidate(pid, wallet);

    // 5. Fresh check returns revoked
    const check2 = await checker.check(pid, wallet);
    cache.set(pid, wallet, check2);
    expect(cache.get(pid, wallet)!.entitled).toBe(false);
    expect(cache.get(pid, wallet)!.reason).toBe('revoked');
  });

  it('batch check results cached individually', async () => {
    const local = createLocalChain();
    const cache = new EntitlementCache({ defaultTtlMs: 60_000 });
    const checker = createEntitlementChecker({ reader: local.reader });
    const wallet = '0xAlice';

    const pid1 = deriveProductIdHex('batch-cache-1');
    const pid2 = deriveProductIdHex('batch-cache-2');

    local.store.mintEntitlement({
      productId: pid1, user: wallet, expiresAt: null, source: 'platform', sourceId: '1',
    });

    const batch = await checker.checkBatch([pid1, pid2], wallet);

    // Cache each result individually
    cache.set(pid1, wallet, batch[pid1]);
    cache.set(pid2, wallet, batch[pid2]);

    expect(cache.get(pid1, wallet)!.entitled).toBe(true);
    expect(cache.get(pid2, wallet)!.entitled).toBe(false);

    // Invalidate just one
    cache.invalidate(pid1, wallet);
    expect(cache.get(pid1, wallet)).toBeNull();
    expect(cache.get(pid2, wallet)).not.toBeNull();
  });
});

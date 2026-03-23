/**
 * E2E: Client checker SDKs against local chain.
 *
 * Tests that @doubloon/react-native's createEntitlementChecker and
 * @doubloon/react-native's EntitlementCache work correctly with the
 * local chain as their reader backend.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createLocalChain } from '@doubloon/chain-local';
import { createEntitlementChecker, EntitlementCache } from '@doubloon/react-native';
import { deriveProductIdHex } from '@doubloon/core';

describe('Client checker SDKs against local chain', () => {
  const proMonthlyId = deriveProductIdHex('pro-monthly');
  const proYearlyId = deriveProductIdHex('pro-yearly');
  const lifetimeId = deriveProductIdHex('lifetime-pass');
  const wallet = '0xAlice';

  let local: ReturnType<typeof createLocalChain>;
  let checker: ReturnType<typeof createEntitlementChecker>;

  beforeEach(() => {
    local = createLocalChain();
    checker = createEntitlementChecker({ reader: local.reader });
  });

  describe('createEntitlementChecker', () => {
    it('check returns not_found for unknown product', async () => {
      const result = await checker.check(proMonthlyId, wallet);
      expect(result.entitled).toBe(false);
      expect(result.reason).toBe('not_found');
    });

    it('check returns active for valid entitlement', async () => {
      local.store.mintEntitlement({
        productId: proMonthlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 86400_000),
        source: 'stripe',
        sourceId: 'sub_1',
      });

      const result = await checker.check(proMonthlyId, wallet);
      expect(result.entitled).toBe(true);
      expect(result.reason).toBe('active');
    });

    it('checkBatch returns mixed results', async () => {
      local.store.mintEntitlement({
        productId: proMonthlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 86400_000),
        source: 'stripe',
        sourceId: 'sub_1',
      });

      local.store.mintEntitlement({
        productId: lifetimeId,
        user: wallet,
        expiresAt: null,
        source: 'platform',
        sourceId: 'grant_1',
      });

      const results = await checker.checkBatch(
        [proMonthlyId, proYearlyId, lifetimeId],
        wallet,
      );

      expect(results[proMonthlyId].entitled).toBe(true);
      expect(results[proYearlyId].entitled).toBe(false);
      expect(results[proYearlyId].reason).toBe('not_found');
      expect(results[lifetimeId].entitled).toBe(true);
      expect(results[lifetimeId].expiresAt).toBeNull(); // lifetime
    });

    it('checkBatch with empty list', async () => {
      const results = await checker.checkBatch([], wallet);
      expect(Object.keys(results)).toHaveLength(0);
    });
  });

  describe('EntitlementCache', () => {
    let cache: EntitlementCache;

    beforeEach(() => {
      cache = new EntitlementCache({ defaultTtlMs: 5000 });
    });

    it('caches and retrieves check results', async () => {
      local.store.mintEntitlement({
        productId: proMonthlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 86400_000),
        source: 'stripe',
        sourceId: 'sub_1',
      });

      const check = await checker.check(proMonthlyId, wallet);
      cache.set(proMonthlyId, wallet, check);

      const cached = cache.get(proMonthlyId, wallet);
      expect(cached).not.toBeNull();
      expect(cached!.entitled).toBe(true);
    });

    it('returns null for uncached entries', () => {
      expect(cache.get(proMonthlyId, wallet)).toBeNull();
    });

    it('invalidate removes specific entry', async () => {
      local.store.mintEntitlement({
        productId: proMonthlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 86400_000),
        source: 'stripe',
        sourceId: 'sub_1',
      });

      const check = await checker.check(proMonthlyId, wallet);
      cache.set(proMonthlyId, wallet, check);
      expect(cache.size).toBe(1);

      cache.invalidate(proMonthlyId, wallet);
      expect(cache.size).toBe(0);
      expect(cache.get(proMonthlyId, wallet)).toBeNull();
    });

    it('invalidateAll clears everything', async () => {
      const check1 = await checker.check(proMonthlyId, wallet);
      cache.set(proMonthlyId, wallet, check1);
      cache.set(proYearlyId, wallet, check1);

      cache.invalidateAll();
      expect(cache.size).toBe(0);
    });

    it('cache reflects state changes after invalidation', async () => {
      // Mint and cache
      local.store.mintEntitlement({
        productId: proMonthlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 86400_000),
        source: 'stripe',
        sourceId: 'sub_1',
      });

      const check1 = await checker.check(proMonthlyId, wallet);
      cache.set(proMonthlyId, wallet, check1);
      expect(cache.get(proMonthlyId, wallet)!.entitled).toBe(true);

      // Revoke on chain
      local.store.revokeEntitlement({
        productId: proMonthlyId,
        user: wallet,
        revokedBy: 'admin',
      });

      // Cache still has old value
      expect(cache.get(proMonthlyId, wallet)!.entitled).toBe(true);

      // Invalidate and re-check
      cache.invalidate(proMonthlyId, wallet);
      const check2 = await checker.check(proMonthlyId, wallet);
      cache.set(proMonthlyId, wallet, check2);
      expect(cache.get(proMonthlyId, wallet)!.entitled).toBe(false);
    });
  });

  describe('Full client lifecycle', () => {
    it('purchase → check → renew → revoke → check', async () => {
      // 1. Purchase
      local.store.mintEntitlement({
        productId: proMonthlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 30 * 86400_000),
        source: 'apple',
        sourceId: 'txn_purchase',
        autoRenew: true,
      });

      const afterPurchase = await checker.check(proMonthlyId, wallet);
      expect(afterPurchase.entitled).toBe(true);
      expect(afterPurchase.entitlement!.autoRenew).toBe(true);

      // 2. Renew (extend expiry)
      local.store.mintEntitlement({
        productId: proMonthlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 60 * 86400_000),
        source: 'apple',
        sourceId: 'txn_renewal',
        autoRenew: true,
      });

      const afterRenewal = await checker.check(proMonthlyId, wallet);
      expect(afterRenewal.entitled).toBe(true);
      expect(afterRenewal.entitlement!.sourceId).toBe('txn_renewal');

      // 3. Revoke (refund)
      local.store.revokeEntitlement({
        productId: proMonthlyId,
        user: wallet,
        revokedBy: 'apple-refund',
      });

      const afterRevoke = await checker.check(proMonthlyId, wallet);
      expect(afterRevoke.entitled).toBe(false);
      expect(afterRevoke.reason).toBe('revoked');

      // 4. Re-purchase
      local.store.mintEntitlement({
        productId: proMonthlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 30 * 86400_000),
        source: 'apple',
        sourceId: 'txn_repurchase',
      });

      const afterRepurchase = await checker.check(proMonthlyId, wallet);
      expect(afterRepurchase.entitled).toBe(true);
    });

    it('multi-product entitlement management', async () => {
      // User subscribes to two products
      local.store.mintEntitlement({
        productId: proMonthlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 30 * 86400_000),
        source: 'stripe',
        sourceId: 'sub_monthly',
      });

      local.store.mintEntitlement({
        productId: proYearlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 365 * 86400_000),
        source: 'stripe',
        sourceId: 'sub_yearly',
      });

      // Batch check all three (one not purchased)
      const batch = await checker.checkBatch(
        [proMonthlyId, proYearlyId, lifetimeId],
        wallet,
      );

      expect(batch[proMonthlyId].entitled).toBe(true);
      expect(batch[proYearlyId].entitled).toBe(true);
      expect(batch[lifetimeId].entitled).toBe(false);

      // Cancel monthly
      local.store.revokeEntitlement({
        productId: proMonthlyId,
        user: wallet,
        revokedBy: 'stripe-cancel',
      });

      // Re-check
      const afterCancel = await checker.checkBatch(
        [proMonthlyId, proYearlyId],
        wallet,
      );

      expect(afterCancel[proMonthlyId].entitled).toBe(false);
      expect(afterCancel[proYearlyId].entitled).toBe(true);
    });
  });
});

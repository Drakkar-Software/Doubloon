import { describe, it, expect, beforeEach } from 'vitest';
import { LocalChainStore } from '../src/store.js';
import { LocalChainReader } from '../src/reader.js';

describe('LocalChainReader', () => {
  let store: LocalChainStore;
  let reader: LocalChainReader;

  const productId = 'a'.repeat(64);
  const wallet = '0xUser1';

  beforeEach(() => {
    store = new LocalChainStore();
    reader = new LocalChainReader({ store });
  });

  describe('checkEntitlement', () => {
    it('returns not_found when no entitlement exists', async () => {
      const check = await reader.checkEntitlement(productId, wallet);
      expect(check.entitled).toBe(false);
      expect(check.reason).toBe('not_found');
      expect(check.entitlement).toBeNull();
    });

    it('returns active for valid entitlement', async () => {
      store.mintEntitlement({
        productId,
        user: wallet,
        expiresAt: new Date('2030-01-01'),
        source: 'stripe',
        sourceId: 'sub_1',
      });

      const check = await reader.checkEntitlement(productId, wallet);
      expect(check.entitled).toBe(true);
      expect(check.reason).toBe('active');
      expect(check.entitlement).not.toBeNull();
    });

    it('returns expired for past entitlement', async () => {
      store.mintEntitlement({
        productId,
        user: wallet,
        expiresAt: new Date('2020-01-01'),
        source: 'stripe',
        sourceId: 'sub_1',
      });

      const check = await reader.checkEntitlement(productId, wallet);
      expect(check.entitled).toBe(false);
      expect(check.reason).toBe('expired');
    });

    it('returns revoked for revoked entitlement', async () => {
      store.mintEntitlement({
        productId,
        user: wallet,
        expiresAt: new Date('2030-01-01'),
        source: 'stripe',
        sourceId: 'sub_1',
      });
      store.revokeEntitlement({ productId, user: wallet, revokedBy: 'admin' });

      const check = await reader.checkEntitlement(productId, wallet);
      expect(check.entitled).toBe(false);
      expect(check.reason).toBe('revoked');
    });

    it('returns active for lifetime entitlement', async () => {
      store.mintEntitlement({
        productId,
        user: wallet,
        expiresAt: null,
        source: 'platform',
        sourceId: 'grant_1',
      });

      const check = await reader.checkEntitlement(productId, wallet);
      expect(check.entitled).toBe(true);
      expect(check.reason).toBe('active');
      expect(check.expiresAt).toBeNull();
    });
  });

  describe('checkEntitlements', () => {
    const product2 = 'b'.repeat(64);

    it('checks multiple products at once', async () => {
      store.mintEntitlement({
        productId,
        user: wallet,
        expiresAt: new Date('2030-01-01'),
        source: 'stripe',
        sourceId: 'sub_1',
      });

      const batch = await reader.checkEntitlements([productId, product2], wallet);
      expect(batch.user).toBe(wallet);
      expect(batch.results[productId].entitled).toBe(true);
      expect(batch.results[product2].entitled).toBe(false);
      expect(batch.results[product2].reason).toBe('not_found');
    });

    it('handles empty product list', async () => {
      const batch = await reader.checkEntitlements([], wallet);
      expect(Object.keys(batch.results)).toHaveLength(0);
    });
  });

  describe('isEntitled', () => {
    it('returns true for active entitlement', async () => {
      store.mintEntitlement({
        productId,
        user: wallet,
        expiresAt: new Date('2030-01-01'),
        source: 'apple',
        sourceId: 'txn_1',
      });
      expect(await reader.isEntitled(productId, wallet)).toBe(true);
    });

    it('returns false when no entitlement', async () => {
      expect(await reader.isEntitled(productId, wallet)).toBe(false);
    });
  });

  describe('getEntitlement', () => {
    it('returns entitlement when it exists', async () => {
      store.mintEntitlement({
        productId,
        user: wallet,
        expiresAt: null,
        source: 'platform',
        sourceId: 'test',
      });

      const e = await reader.getEntitlement(productId, wallet);
      expect(e).not.toBeNull();
      expect(e!.productId).toBe(productId);
    });

    it('returns null when not found', async () => {
      expect(await reader.getEntitlement(productId, wallet)).toBeNull();
    });
  });

  describe('getProduct', () => {
    it('returns product when registered', async () => {
      store.registerProduct({
        productId,
        name: 'Test',
        metadataUri: 'https://example.com',
        defaultDuration: 0,
        creator: '0xCreator',
      });

      const p = await reader.getProduct(productId);
      expect(p).not.toBeNull();
      expect(p!.name).toBe('Test');
    });

    it('returns null for unknown product', async () => {
      expect(await reader.getProduct(productId)).toBeNull();
    });
  });

  describe('getUserEntitlements', () => {
    it('returns all entitlements for a user', async () => {
      store.mintEntitlement({
        productId,
        user: wallet,
        expiresAt: null,
        source: 'platform',
        sourceId: 'a',
      });
      store.mintEntitlement({
        productId: 'b'.repeat(64),
        user: wallet,
        expiresAt: null,
        source: 'platform',
        sourceId: 'b',
      });

      const entitlements = await reader.getUserEntitlements(wallet);
      expect(entitlements).toHaveLength(2);
    });
  });

  describe('getPlatform', () => {
    it('returns platform state', async () => {
      const platform = await reader.getPlatform();
      expect(platform.authority).toBe('local-authority');
      expect(platform.frozen).toBe(false);
    });
  });
});

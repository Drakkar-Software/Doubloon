import { describe, it, expect, beforeEach } from 'vitest';
import { LocalChainStore } from '../src/store.js';

describe('LocalChainStore', () => {
  let store: LocalChainStore;

  beforeEach(() => {
    store = new LocalChainStore();
  });

  describe('platform', () => {
    it('creates with default platform state', () => {
      const platform = store.getPlatform();
      expect(platform.authority).toBe('local-authority');
      expect(platform.productCount).toBe(0);
      expect(platform.frozen).toBe(false);
    });

    it('accepts custom authority', () => {
      const custom = new LocalChainStore({ authority: '0xAdmin' });
      expect(custom.getPlatform().authority).toBe('0xAdmin');
    });

    it('returns a copy (not mutable reference)', () => {
      const p1 = store.getPlatform();
      const p2 = store.getPlatform();
      expect(p1).toEqual(p2);
      expect(p1).not.toBe(p2);
    });
  });

  describe('products', () => {
    const productParams = {
      productId: 'a'.repeat(64),
      name: 'Test Product',
      metadataUri: 'https://example.com/meta.json',
      defaultDuration: 2592000,
      creator: '0xCreator',
    };

    it('registers and retrieves a product', () => {
      const product = store.registerProduct(productParams);
      expect(product.productId).toBe(productParams.productId);
      expect(product.name).toBe('Test Product');
      expect(product.active).toBe(true);
      expect(product.frozen).toBe(false);
      expect(product.entitlementCount).toBe(0);

      const retrieved = store.getProduct(productParams.productId);
      expect(retrieved).toEqual(product);
    });

    it('increments platform product count', () => {
      store.registerProduct(productParams);
      expect(store.getPlatform().productCount).toBe(1);
      store.registerProduct({ ...productParams, productId: 'b'.repeat(64) });
      expect(store.getPlatform().productCount).toBe(2);
    });

    it('returns null for unknown product', () => {
      expect(store.getProduct('nonexistent')).toBeNull();
    });

    it('lists all products', () => {
      store.registerProduct(productParams);
      store.registerProduct({ ...productParams, productId: 'b'.repeat(64), name: 'Product 2' });
      expect(store.getAllProducts()).toHaveLength(2);
    });

    it('re-registering same productId does not increment count', () => {
      store.registerProduct(productParams);
      store.registerProduct({ ...productParams, name: 'Updated Name' });
      expect(store.getPlatform().productCount).toBe(1);
      expect(store.getProduct(productParams.productId)!.name).toBe('Updated Name');
    });

    it('re-registering preserves entitlementCount', () => {
      store.registerProduct(productParams);
      store.mintEntitlement({
        productId: productParams.productId,
        user: '0xUser',
        expiresAt: null,
        source: 'platform',
        sourceId: 'test',
      });
      store.registerProduct({ ...productParams, name: 'Updated' });
      expect(store.getProduct(productParams.productId)!.entitlementCount).toBe(1);
    });

    it('setProductActive deactivates and reactivates', () => {
      store.registerProduct(productParams);
      store.setProductActive(productParams.productId, false);
      expect(store.getProduct(productParams.productId)!.active).toBe(false);
      store.setProductActive(productParams.productId, true);
      expect(store.getProduct(productParams.productId)!.active).toBe(true);
    });

    it('setProductFrozen freezes and unfreezes', () => {
      store.registerProduct(productParams);
      store.setProductFrozen(productParams.productId, true);
      expect(store.getProduct(productParams.productId)!.frozen).toBe(true);
      store.setProductFrozen(productParams.productId, false);
      expect(store.getProduct(productParams.productId)!.frozen).toBe(false);
    });

    it('setProductActive/Frozen no-ops for unknown product', () => {
      store.setProductActive('unknown', false);
      store.setProductFrozen('unknown', true);
      // No error thrown, no side effects
      expect(store.getProduct('unknown')).toBeNull();
    });
  });

  describe('entitlements', () => {
    const mintParams = {
      productId: 'a'.repeat(64),
      user: '0xUser1',
      expiresAt: new Date('2030-01-01'),
      source: 'stripe' as const,
      sourceId: 'sub_123',
    };

    it('mints and retrieves an entitlement', () => {
      const { entitlement, txHash } = store.mintEntitlement(mintParams);
      expect(entitlement.productId).toBe(mintParams.productId);
      expect(entitlement.user).toBe('0xUser1');
      expect(entitlement.active).toBe(true);
      expect(entitlement.source).toBe('stripe');
      expect(entitlement.revokedAt).toBeNull();
      expect(txHash).toMatch(/^0xlocal/);

      const retrieved = store.getEntitlement(mintParams.productId, '0xUser1');
      expect(retrieved).toEqual(entitlement);
    });

    it('returns null for unknown entitlement', () => {
      expect(store.getEntitlement('x', 'y')).toBeNull();
    });

    it('updates existing entitlement on re-mint (preserves grantedAt)', () => {
      const first = store.mintEntitlement(mintParams);
      const firstGrantedAt = first.entitlement.grantedAt;

      const second = store.mintEntitlement({
        ...mintParams,
        expiresAt: new Date('2031-01-01'),
        sourceId: 'sub_456',
      });

      expect(second.entitlement.grantedAt).toEqual(firstGrantedAt);
      expect(second.entitlement.expiresAt).toEqual(new Date('2031-01-01'));
      expect(second.entitlement.sourceId).toBe('sub_456');
    });

    it('increments product entitlement count on new mint', () => {
      store.registerProduct({
        productId: mintParams.productId,
        name: 'Test',
        metadataUri: '',
        defaultDuration: 0,
        creator: '0x',
      });

      store.mintEntitlement(mintParams);
      expect(store.getProduct(mintParams.productId)!.entitlementCount).toBe(1);

      // Re-mint for same user should NOT increment
      store.mintEntitlement({ ...mintParams, sourceId: 'sub_new' });
      expect(store.getProduct(mintParams.productId)!.entitlementCount).toBe(1);

      // New user SHOULD increment
      store.mintEntitlement({ ...mintParams, user: '0xUser2' });
      expect(store.getProduct(mintParams.productId)!.entitlementCount).toBe(2);
    });

    it('supports lifetime entitlements (null expiresAt)', () => {
      const { entitlement } = store.mintEntitlement({ ...mintParams, expiresAt: null });
      expect(entitlement.expiresAt).toBeNull();
    });

    it('supports autoRenew flag', () => {
      const { entitlement } = store.mintEntitlement({ ...mintParams, autoRenew: true });
      expect(entitlement.autoRenew).toBe(true);
    });

    it('defaults autoRenew to false', () => {
      const { entitlement } = store.mintEntitlement(mintParams);
      expect(entitlement.autoRenew).toBe(false);
    });

    it('filters entitlements by user', () => {
      store.mintEntitlement(mintParams);
      store.mintEntitlement({ ...mintParams, productId: 'b'.repeat(64) });
      store.mintEntitlement({ ...mintParams, user: '0xOther' });

      expect(store.getUserEntitlements('0xUser1')).toHaveLength(2);
      expect(store.getUserEntitlements('0xOther')).toHaveLength(1);
      expect(store.getUserEntitlements('0xNobody')).toHaveLength(0);
    });

    it('generates unique tx hashes', () => {
      const h1 = store.mintEntitlement(mintParams).txHash;
      const h2 = store.mintEntitlement({ ...mintParams, user: '0xUser2' }).txHash;
      expect(h1).not.toBe(h2);
    });

    it('returns all entitlements via getAllEntitlements', () => {
      store.mintEntitlement(mintParams);
      store.mintEntitlement({ ...mintParams, user: '0xUser2' });
      expect(store.getAllEntitlements()).toHaveLength(2);
    });
  });

  describe('revocation', () => {
    const mintParams = {
      productId: 'a'.repeat(64),
      user: '0xUser1',
      expiresAt: new Date('2030-01-01'),
      source: 'stripe' as const,
      sourceId: 'sub_123',
    };

    it('revokes an existing entitlement', () => {
      store.mintEntitlement(mintParams);
      const result = store.revokeEntitlement({
        productId: mintParams.productId,
        user: '0xUser1',
        revokedBy: 'admin',
      });

      expect(result).not.toBeNull();
      expect(result!.entitlement.active).toBe(false);
      expect(result!.entitlement.revokedAt).toBeInstanceOf(Date);
      expect(result!.entitlement.revokedBy).toBe('admin');
      expect(result!.txHash).toMatch(/^0xlocal/);
    });

    it('returns null when revoking non-existent entitlement', () => {
      const result = store.revokeEntitlement({
        productId: 'nonexistent',
        user: '0xUser1',
        revokedBy: 'admin',
      });
      expect(result).toBeNull();
    });

    it('persists revocation in store', () => {
      store.mintEntitlement(mintParams);
      store.revokeEntitlement({
        productId: mintParams.productId,
        user: '0xUser1',
        revokedBy: 'admin',
      });

      const entitlement = store.getEntitlement(mintParams.productId, '0xUser1');
      expect(entitlement!.active).toBe(false);
    });
  });

  describe('delegates', () => {
    it('grants and retrieves a delegation', () => {
      const d = store.grantDelegation({
        productId: 'a'.repeat(64),
        delegate: '0xDelegate',
        grantedBy: '0xCreator',
        expiresAt: null,
        maxMints: 100,
      });

      expect(d.active).toBe(true);
      expect(d.maxMints).toBe(100);
      expect(d.mintsUsed).toBe(0);

      const retrieved = store.getDelegate('a'.repeat(64), '0xDelegate');
      expect(retrieved).toEqual(d);
    });

    it('returns null for unknown delegate', () => {
      expect(store.getDelegate('x', 'y')).toBeNull();
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      store.registerProduct({
        productId: 'a'.repeat(64),
        name: 'Test',
        metadataUri: '',
        defaultDuration: 0,
        creator: '0x',
      });
      store.mintEntitlement({
        productId: 'a'.repeat(64),
        user: '0x1',
        expiresAt: null,
        source: 'platform',
        sourceId: 'test',
      });

      store.clear();

      expect(store.productCount).toBe(0);
      expect(store.entitlementCount).toBe(0);
      expect(store.getPlatform().productCount).toBe(0);
    });
  });
});

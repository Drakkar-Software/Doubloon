import { describe, it, expect, beforeEach } from 'vitest';
import { LocalChainStore } from '../src/store.js';
import { LocalChainWriter } from '../src/writer.js';
import { DoubloonError } from '@doubloon/core';

describe('LocalChainWriter', () => {
  let store: LocalChainStore;
  let writer: LocalChainWriter;

  const productId = 'a'.repeat(64);

  beforeEach(() => {
    store = new LocalChainStore();
    writer = new LocalChainWriter({ store });
  });

  describe('mintEntitlement', () => {
    it('mints an entitlement and returns a tx hash', async () => {
      const result = await writer.mintEntitlement({
        productId,
        user: '0xUser1',
        expiresAt: new Date('2030-01-01'),
        source: 'stripe',
        sourceId: 'sub_1',
        signer: 'admin',
      });

      expect(result.hash).toBeTruthy();
      expect(store.getEntitlement(productId, '0xUser1')).not.toBeNull();
    });

    it('creates entitlement with correct fields', async () => {
      await writer.mintEntitlement({
        productId,
        user: '0xUser1',
        expiresAt: new Date('2030-06-15'),
        source: 'apple',
        sourceId: 'txn_apple_1',
        signer: 'admin',
        autoRenew: true,
      });

      const e = store.getEntitlement(productId, '0xUser1')!;
      expect(e.source).toBe('apple');
      expect(e.sourceId).toBe('txn_apple_1');
      expect(e.autoRenew).toBe(true);
      expect(e.active).toBe(true);
    });

    it('throws PRODUCT_FROZEN when platform is frozen', async () => {
      const frozenStore = new LocalChainStore({ frozen: true });
      const frozenWriter = new LocalChainWriter({ store: frozenStore });

      await expect(
        frozenWriter.mintEntitlement({
          productId,
          user: '0xUser1',
          expiresAt: null,
          source: 'platform',
          sourceId: 'test',
          signer: 'admin',
        }),
      ).rejects.toMatchObject({ code: 'PRODUCT_FROZEN' });
    });

    it('throws PRODUCT_NOT_ACTIVE when product is inactive', async () => {
      store.registerProduct({
        productId,
        name: 'Test',
        metadataUri: '',
        defaultDuration: 0,
        creator: '0x',
      });
      store.setProductActive(productId, false);

      await expect(
        writer.mintEntitlement({
          productId,
          user: '0xUser1',
          expiresAt: null,
          source: 'platform',
          sourceId: 'test',
          signer: 'admin',
        }),
      ).rejects.toMatchObject({ code: 'PRODUCT_NOT_ACTIVE' });
    });

    it('throws PRODUCT_FROZEN when product-level freeze is set', async () => {
      store.registerProduct({
        productId,
        name: 'Test',
        metadataUri: '',
        defaultDuration: 0,
        creator: '0x',
      });
      store.setProductFrozen(productId, true);

      await expect(
        writer.mintEntitlement({
          productId,
          user: '0xUser1',
          expiresAt: null,
          source: 'platform',
          sourceId: 'test',
          signer: 'admin',
        }),
      ).rejects.toMatchObject({ code: 'PRODUCT_FROZEN' });
    });

    it('mints without pre-registered product (ad-hoc entitlement)', async () => {
      const result = await writer.mintEntitlement({
        productId,
        user: '0xUser1',
        expiresAt: null,
        source: 'platform',
        sourceId: 'grant_1',
        signer: 'admin',
      });

      expect(result.hash).toBeTruthy();
      expect(store.getEntitlement(productId, '0xUser1')!.active).toBe(true);
    });
  });

  describe('revokeEntitlement', () => {
    it('revokes an existing entitlement', async () => {
      await writer.mintEntitlement({
        productId,
        user: '0xUser1',
        expiresAt: null,
        source: 'platform',
        sourceId: 'test',
        signer: 'admin',
      });

      const result = await writer.revokeEntitlement({
        productId,
        user: '0xUser1',
        reason: 'refund',
        signer: 'admin',
      });

      expect(result.hash).toBeTruthy();
      expect(store.getEntitlement(productId, '0xUser1')!.active).toBe(false);
      expect(store.getEntitlement(productId, '0xUser1')!.revokedBy).toBe('admin');
    });

    it('throws ACCOUNT_NOT_FOUND when entitlement does not exist', async () => {
      await expect(
        writer.revokeEntitlement({
          productId,
          user: '0xUser1',
          reason: 'refund',
          signer: 'admin',
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    });
  });

  describe('registerProduct', () => {
    it('registers a product and returns hash', async () => {
      const result = await writer.registerProduct({
        productId,
        name: 'My Product',
        metadataUri: 'https://example.com/meta.json',
        defaultDuration: 2592000,
        signer: '0xCreator',
      });

      expect(result.hash).toBeTruthy();
      const product = store.getProduct(productId);
      expect(product).not.toBeNull();
      expect(product!.name).toBe('My Product');
      expect(product!.creator).toBe('0xCreator');
    });
  });
});

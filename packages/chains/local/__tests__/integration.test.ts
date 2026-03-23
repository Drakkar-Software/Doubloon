import { describe, it, expect, beforeEach } from 'vitest';
import { createLocalChain } from '../src/create-local-chain.js';
import type { LocalChain } from '../src/create-local-chain.js';

/**
 * Integration tests that exercise the full local chain stack
 * (store + reader + writer + signer) together, simulating real
 * server-like workflows without any blockchain.
 */
describe('LocalChain integration', () => {
  let chain: LocalChain;

  beforeEach(() => {
    chain = createLocalChain({ authority: '0xAdmin', signerKey: '0xSigner' });
  });

  it('creates all components', () => {
    expect(chain.store).toBeDefined();
    expect(chain.reader).toBeDefined();
    expect(chain.writer).toBeDefined();
    expect(chain.signer).toBeDefined();
    expect(chain.signer.publicKey).toBe('0xSigner');
  });

  describe('full subscription lifecycle', () => {
    const productId = 'a'.repeat(64);
    const user = '0xSubscriber';

    it('mint -> check -> renew -> check -> revoke -> check', async () => {
      // 1. Register product
      await chain.writer.registerProduct({
        productId,
        name: 'Pro Plan',
        metadataUri: 'https://example.com/pro.json',
        defaultDuration: 2592000, // 30 days
        signer: chain.signer.publicKey,
      });

      // 2. Verify product exists
      const product = await chain.reader.getProduct(productId);
      expect(product).not.toBeNull();
      expect(product!.name).toBe('Pro Plan');

      // 3. Check entitlement — should not exist yet
      const check1 = await chain.reader.checkEntitlement(productId, user);
      expect(check1.entitled).toBe(false);
      expect(check1.reason).toBe('not_found');

      // 4. Mint entitlement (simulating a Stripe subscription)
      const mintTx = await chain.writer.mintEntitlement({
        productId,
        user,
        expiresAt: new Date('2030-06-01'),
        source: 'stripe',
        sourceId: 'sub_stripe_123',
        signer: chain.signer.publicKey,
      });
      const mintSig = await chain.signer.signAndSend(mintTx);
      expect(mintSig).toMatch(/^local-sig-/);

      // 5. Check entitlement — should be active
      const check2 = await chain.reader.checkEntitlement(productId, user);
      expect(check2.entitled).toBe(true);
      expect(check2.reason).toBe('active');
      expect(check2.entitlement!.source).toBe('stripe');

      // 6. isEntitled shorthand
      expect(await chain.reader.isEntitled(productId, user)).toBe(true);

      // 7. Renew (re-mint with extended expiry)
      await chain.writer.mintEntitlement({
        productId,
        user,
        expiresAt: new Date('2031-06-01'),
        source: 'stripe',
        sourceId: 'sub_stripe_456',
        signer: chain.signer.publicKey,
        autoRenew: true,
      });

      // 8. Check renewed entitlement
      const check3 = await chain.reader.checkEntitlement(productId, user);
      expect(check3.entitled).toBe(true);
      expect(check3.entitlement!.expiresAt).toEqual(new Date('2031-06-01'));
      expect(check3.entitlement!.autoRenew).toBe(true);

      // 9. Revoke
      const revokeTx = await chain.writer.revokeEntitlement({
        productId,
        user,
        reason: 'refund',
        signer: chain.signer.publicKey,
      });
      await chain.signer.signAndSend(revokeTx);

      // 10. Check revoked
      const check4 = await chain.reader.checkEntitlement(productId, user);
      expect(check4.entitled).toBe(false);
      expect(check4.reason).toBe('revoked');
      expect(check4.entitlement!.revokedBy).toBe(chain.signer.publicKey);
    });
  });

  describe('batch entitlement checks', () => {
    const products = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const user = '0xUser';

    it('checks multiple products in one call', async () => {
      // Only grant 2 out of 3
      chain.store.mintEntitlement({
        productId: products[0],
        user,
        expiresAt: new Date('2030-01-01'),
        source: 'stripe',
        sourceId: 'sub_1',
      });
      chain.store.mintEntitlement({
        productId: products[2],
        user,
        expiresAt: null, // lifetime
        source: 'platform',
        sourceId: 'grant_1',
      });

      const batch = await chain.reader.checkEntitlements(products, user);
      expect(batch.user).toBe(user);
      expect(batch.results[products[0]].entitled).toBe(true);
      expect(batch.results[products[1]].entitled).toBe(false);
      expect(batch.results[products[1]].reason).toBe('not_found');
      expect(batch.results[products[2]].entitled).toBe(true);
      expect(batch.results[products[2]].expiresAt).toBeNull(); // lifetime
    });
  });

  describe('multi-user scenario', () => {
    const productId = 'a'.repeat(64);

    it('tracks entitlements per user independently', async () => {
      chain.store.mintEntitlement({
        productId,
        user: '0xAlice',
        expiresAt: new Date('2030-01-01'),
        source: 'apple',
        sourceId: 'txn_1',
      });
      chain.store.mintEntitlement({
        productId,
        user: '0xBob',
        expiresAt: new Date('2020-01-01'), // expired
        source: 'google',
        sourceId: 'txn_2',
      });

      expect(await chain.reader.isEntitled(productId, '0xAlice')).toBe(true);
      expect(await chain.reader.isEntitled(productId, '0xBob')).toBe(false);
      expect(await chain.reader.isEntitled(productId, '0xCharlie')).toBe(false);
    });
  });

  describe('store reset', () => {
    it('clear() resets everything for test isolation', async () => {
      chain.store.mintEntitlement({
        productId: 'a'.repeat(64),
        user: '0xUser',
        expiresAt: null,
        source: 'platform',
        sourceId: 'x',
      });

      expect(await chain.reader.isEntitled('a'.repeat(64), '0xUser')).toBe(true);

      chain.store.clear();

      expect(await chain.reader.isEntitled('a'.repeat(64), '0xUser')).toBe(false);
      expect(chain.store.entitlementCount).toBe(0);
    });
  });

  describe('signer', () => {
    it('generates unique signatures', async () => {
      const sig1 = await chain.signer.signAndSend({ mock: 'tx1' });
      const sig2 = await chain.signer.signAndSend({ mock: 'tx2' });
      expect(sig1).not.toBe(sig2);
      expect(sig1).toMatch(/^local-sig-/);
    });
  });

  describe('createLocalChain defaults', () => {
    it('works with no config', () => {
      const defaultChain = createLocalChain();
      expect(defaultChain.signer.publicKey).toBe('local-signer');
      expect(defaultChain.store.getPlatform().authority).toBe('local-authority');
    });
  });
});

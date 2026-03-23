/**
 * E2E: Advanced scenarios — delegation, concurrency, edge cases, product lifecycle.
 *
 * Tests complex real-world patterns that span multiple subsystems.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLocalChain, LocalChainStore, LocalChainWriter } from '@doubloon/chain-local';
import { createServer } from '@doubloon/server';
import { createEntitlementChecker, EntitlementCache } from '@doubloon/react-native';
import { deriveProductIdHex, checkEntitlement, checkEntitlements } from '@doubloon/core';
import type { Entitlement } from '@doubloon/core';

describe('Delegation system', () => {
  let local: ReturnType<typeof createLocalChain>;
  const productId = deriveProductIdHex('premium-api');

  beforeEach(() => {
    local = createLocalChain();
    local.store.registerProduct({
      productId,
      name: 'Premium API',
      metadataUri: '',
      defaultDuration: 0,
      creator: '0xCreator',
    });
  });

  it('grants and reads a delegation', () => {
    const delegate = local.store.grantDelegation({
      productId,
      delegate: '0xPartner',
      grantedBy: '0xCreator',
      expiresAt: new Date(Date.now() + 86400_000),
      maxMints: 100,
    });

    expect(delegate.active).toBe(true);
    expect(delegate.maxMints).toBe(100);
    expect(delegate.mintsUsed).toBe(0);
    expect(delegate.delegate).toBe('0xPartner');

    const fetched = local.store.getDelegate(productId, '0xPartner');
    expect(fetched).not.toBeNull();
    expect(fetched!.grantedBy).toBe('0xCreator');
  });

  it('delegation with unlimited mints (maxMints=0)', () => {
    const delegate = local.store.grantDelegation({
      productId,
      delegate: '0xPartner',
      grantedBy: '0xCreator',
      expiresAt: null,
      maxMints: 0,
    });

    expect(delegate.maxMints).toBe(0);
    expect(delegate.expiresAt).toBeNull();
  });

  it('delegate returns null for unknown delegate', () => {
    expect(local.store.getDelegate(productId, '0xUnknown')).toBeNull();
  });

  it('multiple delegates for same product are independent', () => {
    local.store.grantDelegation({
      productId,
      delegate: '0xPartnerA',
      grantedBy: '0xCreator',
      expiresAt: null,
      maxMints: 10,
    });

    local.store.grantDelegation({
      productId,
      delegate: '0xPartnerB',
      grantedBy: '0xCreator',
      expiresAt: null,
      maxMints: 50,
    });

    expect(local.store.getDelegate(productId, '0xPartnerA')!.maxMints).toBe(10);
    expect(local.store.getDelegate(productId, '0xPartnerB')!.maxMints).toBe(50);
  });
});

describe('Product lifecycle', () => {
  let local: ReturnType<typeof createLocalChain>;
  const productId = deriveProductIdHex('feature-flags');
  const wallet = '0xUser';

  beforeEach(() => {
    local = createLocalChain();
  });

  it('deactivated product: existing entitlements remain valid', async () => {
    local.store.registerProduct({
      productId,
      name: 'Feature Flags',
      metadataUri: '',
      defaultDuration: 0,
      creator: '0xCreator',
    });

    local.store.mintEntitlement({
      productId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_1',
    });

    // Deactivate product
    local.store.setProductActive(productId, false);
    const product = local.store.getProduct(productId)!;
    expect(product.active).toBe(false);

    // Existing entitlement still grants access
    const check = await local.reader.checkEntitlement(productId, wallet);
    expect(check.entitled).toBe(true);
  });

  it('deactivated product rejects new mints via writer', async () => {
    local.store.registerProduct({
      productId,
      name: 'Feature Flags',
      metadataUri: '',
      defaultDuration: 0,
      creator: '0xCreator',
    });

    local.store.setProductActive(productId, false);

    await expect(
      local.writer.mintEntitlement({
        productId,
        user: '0xNewUser',
        expiresAt: null,
        source: 'platform',
        sourceId: 'grant_1',
        signer: local.signer.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCT_NOT_ACTIVE' });
  });

  it('reactivated product accepts mints again', async () => {
    local.store.registerProduct({
      productId,
      name: 'Feature Flags',
      metadataUri: '',
      defaultDuration: 0,
      creator: '0xCreator',
    });

    local.store.setProductActive(productId, false);
    local.store.setProductActive(productId, true);

    const result = await local.writer.mintEntitlement({
      productId,
      user: wallet,
      expiresAt: null,
      source: 'platform',
      sourceId: 'grant_1',
      signer: local.signer.publicKey,
    });

    expect(result.hash).toBeTruthy();
  });

  it('frozen product rejects mints', async () => {
    local.store.registerProduct({
      productId,
      name: 'Feature Flags',
      metadataUri: '',
      defaultDuration: 0,
      creator: '0xCreator',
    });

    local.store.setProductFrozen(productId, true);

    await expect(
      local.writer.mintEntitlement({
        productId,
        user: wallet,
        expiresAt: null,
        source: 'platform',
        sourceId: 'grant_1',
        signer: local.signer.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCT_FROZEN' });
  });

  it('unfrozen product accepts mints again', async () => {
    local.store.registerProduct({
      productId,
      name: 'Feature Flags',
      metadataUri: '',
      defaultDuration: 0,
      creator: '0xCreator',
    });

    local.store.setProductFrozen(productId, true);
    local.store.setProductFrozen(productId, false);

    const result = await local.writer.mintEntitlement({
      productId,
      user: wallet,
      expiresAt: null,
      source: 'platform',
      sourceId: 'grant_1',
      signer: local.signer.publicKey,
    });
    expect(result.hash).toBeTruthy();
  });

  it('product re-register preserves entitlement count', async () => {
    local.store.registerProduct({
      productId,
      name: 'Feature Flags',
      metadataUri: '',
      defaultDuration: 0,
      creator: '0xCreator',
    });

    local.store.mintEntitlement({ productId, user: '0xA', expiresAt: null, source: 'platform', sourceId: '1' });
    local.store.mintEntitlement({ productId, user: '0xB', expiresAt: null, source: 'platform', sourceId: '2' });

    // Re-register with updated name
    local.store.registerProduct({
      productId,
      name: 'Feature Flags v2',
      metadataUri: 'https://new.uri',
      defaultDuration: 86400,
      creator: '0xCreator',
    });

    const product = local.store.getProduct(productId)!;
    expect(product.name).toBe('Feature Flags v2');
    expect(product.entitlementCount).toBe(2); // preserved
    expect(product.metadataUri).toBe('https://new.uri');
  });

  it('platform product count increments only for new products', () => {
    local.store.registerProduct({ productId, name: 'P1', metadataUri: '', defaultDuration: 0, creator: '0x' });
    expect(local.store.getPlatform().productCount).toBe(1);

    local.store.registerProduct({ productId, name: 'P1 v2', metadataUri: '', defaultDuration: 0, creator: '0x' });
    expect(local.store.getPlatform().productCount).toBe(1); // same product, no increment

    const product2 = deriveProductIdHex('another-product');
    local.store.registerProduct({ productId: product2, name: 'P2', metadataUri: '', defaultDuration: 0, creator: '0x' });
    expect(local.store.getPlatform().productCount).toBe(2);
  });
});

describe('Concurrency and parallel operations', () => {
  let local: ReturnType<typeof createLocalChain>;
  const productId = deriveProductIdHex('pro-monthly');

  beforeEach(() => {
    local = createLocalChain();
  });

  it('parallel mints for different users do not interfere', async () => {
    const users = Array.from({ length: 20 }, (_, i) => `0xUser${i}`);

    await Promise.all(
      users.map((user) =>
        local.writer.mintEntitlement({
          productId,
          user,
          expiresAt: new Date(Date.now() + 86400_000),
          source: 'stripe',
          sourceId: `sub_${user}`,
          signer: local.signer.publicKey,
        }),
      ),
    );

    expect(local.store.entitlementCount).toBe(20);

    // All users should be entitled
    const checks = await Promise.all(
      users.map((user) => local.reader.checkEntitlement(productId, user)),
    );
    for (const check of checks) {
      expect(check.entitled).toBe(true);
    }
  });

  it('parallel checks for same user return consistent results', async () => {
    local.store.mintEntitlement({
      productId,
      user: '0xAlice',
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_1',
    });

    const checks = await Promise.all(
      Array.from({ length: 50 }, () => local.reader.checkEntitlement(productId, '0xAlice')),
    );

    for (const check of checks) {
      expect(check.entitled).toBe(true);
      expect(check.reason).toBe('active');
    }
  });

  it('parallel batch checks across many products', async () => {
    const products = Array.from({ length: 10 }, (_, i) => deriveProductIdHex(`product-${i}-test`));
    const wallet = '0xAlice';

    // Mint even-indexed products
    for (let i = 0; i < products.length; i += 2) {
      local.store.mintEntitlement({
        productId: products[i],
        user: wallet,
        expiresAt: new Date(Date.now() + 86400_000),
        source: 'stripe',
        sourceId: `sub_${i}`,
      });
    }

    const batch = await local.reader.checkEntitlements(products, wallet);
    expect(Object.keys(batch.results)).toHaveLength(10);

    for (let i = 0; i < products.length; i++) {
      if (i % 2 === 0) {
        expect(batch.results[products[i]].entitled).toBe(true);
      } else {
        expect(batch.results[products[i]].entitled).toBe(false);
        expect(batch.results[products[i]].reason).toBe('not_found');
      }
    }
  });
});

describe('Entitlement edge cases', () => {
  let local: ReturnType<typeof createLocalChain>;
  const productId = deriveProductIdHex('edge-case');
  const wallet = '0xAlice';

  beforeEach(() => {
    local = createLocalChain();
  });

  it('expiry boundary: exactly at expiresAt is NOT entitled (exclusive)', () => {
    const expiresAt = new Date('2030-06-15T12:00:00Z');

    const entitlement: Entitlement = {
      productId,
      user: wallet,
      grantedAt: new Date('2030-05-15T12:00:00Z'),
      expiresAt,
      autoRenew: false,
      source: 'stripe',
      sourceId: 'sub_1',
      active: true,
      revokedAt: null,
      revokedBy: null,
    };

    // 1ms before expiry: entitled
    const before = checkEntitlement(entitlement, new Date(expiresAt.getTime() - 1));
    expect(before.entitled).toBe(true);

    // Exactly at expiry: NOT entitled (exclusive boundary)
    const atExpiry = checkEntitlement(entitlement, expiresAt);
    expect(atExpiry.entitled).toBe(false);
    expect(atExpiry.reason).toBe('expired');

    // 1ms after: NOT entitled
    const after = checkEntitlement(entitlement, new Date(expiresAt.getTime() + 1));
    expect(after.entitled).toBe(false);
  });

  it('revoked entitlement is not entitled regardless of expiry', () => {
    const entitlement: Entitlement = {
      productId,
      user: wallet,
      grantedAt: new Date('2020-01-01'),
      expiresAt: new Date('2099-12-31'), // far future
      autoRenew: true,
      source: 'stripe',
      sourceId: 'sub_1',
      active: false, // revoked
      revokedAt: new Date('2024-01-01'),
      revokedBy: 'admin',
    };

    const check = checkEntitlement(entitlement);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('revoked');
  });

  it('re-mint after revoke reactivates entitlement', async () => {
    local.store.mintEntitlement({
      productId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_1',
    });

    local.store.revokeEntitlement({ productId, user: wallet, revokedBy: 'admin' });
    expect((await local.reader.checkEntitlement(productId, wallet)).entitled).toBe(false);

    // Re-mint
    local.store.mintEntitlement({
      productId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_2',
    });

    const check = await local.reader.checkEntitlement(productId, wallet);
    expect(check.entitled).toBe(true);
    expect(check.entitlement!.active).toBe(true);
    expect(check.entitlement!.revokedAt).toBeNull();
  });

  it('all EntitlementSource values are round-trippable', async () => {
    const sources = ['platform', 'creator', 'delegate', 'apple', 'google', 'stripe', 'x402'] as const;

    for (const source of sources) {
      const pid = deriveProductIdHex(`source-test-${source}`);
      local.store.mintEntitlement({
        productId: pid,
        user: wallet,
        expiresAt: null,
        source,
        sourceId: `${source}_txn`,
      });

      const entitlement = await local.reader.getEntitlement(pid, wallet);
      expect(entitlement!.source).toBe(source);
    }
  });

  it('getUserEntitlements returns all entitlements for a user', async () => {
    const products = Array.from({ length: 5 }, (_, i) => deriveProductIdHex(`user-ent-${i}`));

    for (const pid of products) {
      local.store.mintEntitlement({
        productId: pid,
        user: wallet,
        expiresAt: null,
        source: 'platform',
        sourceId: `grant_${pid.slice(0, 8)}`,
      });
    }

    // Another user
    local.store.mintEntitlement({
      productId: products[0],
      user: '0xBob',
      expiresAt: null,
      source: 'platform',
      sourceId: 'bob_grant',
    });

    const aliceEntitlements = await local.reader.getUserEntitlements(wallet);
    expect(aliceEntitlements).toHaveLength(5);

    const bobEntitlements = await local.reader.getUserEntitlements('0xBob');
    expect(bobEntitlements).toHaveLength(1);
  });

  it('batch checkEntitlements with consistent timestamps', () => {
    const now = new Date('2025-06-15T12:00:00Z');

    const entitlements: Record<string, Entitlement | null> = {
      active: {
        productId: 'a'.repeat(64), user: wallet, grantedAt: new Date('2025-01-01'),
        expiresAt: new Date('2025-12-31'), autoRenew: false, source: 'stripe',
        sourceId: 's1', active: true, revokedAt: null, revokedBy: null,
      },
      expired: {
        productId: 'b'.repeat(64), user: wallet, grantedAt: new Date('2024-01-01'),
        expiresAt: new Date('2025-01-01'), autoRenew: false, source: 'stripe',
        sourceId: 's2', active: true, revokedAt: null, revokedBy: null,
      },
      missing: null,
    };

    const batch = checkEntitlements(entitlements, now);
    expect(batch.results['active'].entitled).toBe(true);
    expect(batch.results['expired'].entitled).toBe(false);
    expect(batch.results['expired'].reason).toBe('expired');
    expect(batch.results['missing'].entitled).toBe(false);
    expect(batch.results['missing'].reason).toBe('not_found');
    expect(batch.checkedAt).toEqual(now);
  });
});

describe('Cache TTL clamping', () => {
  it('cache TTL is clamped to entitlement expiry to prevent stale "entitled" results', () => {
    const cache = new EntitlementCache({ defaultTtlMs: 60_000 });

    // Entitlement expires in 5 seconds
    const expiresAt = new Date(Date.now() + 5000);
    const check = {
      entitled: true,
      entitlement: null,
      reason: 'active' as const,
      expiresAt,
      product: null,
    };

    cache.set('pid', 'wallet', check);

    // Should be cached now
    expect(cache.get('pid', 'wallet')).not.toBeNull();
  });

  it('expired entitlement check does not cache with stale TTL', () => {
    const cache = new EntitlementCache({ defaultTtlMs: 60_000 });

    // Already expired
    const check = {
      entitled: false,
      entitlement: null,
      reason: 'expired' as const,
      expiresAt: null,
      product: null,
    };

    cache.set('pid', 'wallet', check);
    // Should be cached (not_entitled results use default TTL)
    expect(cache.get('pid', 'wallet')).not.toBeNull();
    expect(cache.get('pid', 'wallet')!.entitled).toBe(false);
  });
});

describe('Cross-source entitlement patterns', () => {
  let local: ReturnType<typeof createLocalChain>;
  const productId = deriveProductIdHex('pro-monthly');

  beforeEach(() => {
    local = createLocalChain();
  });

  it('same user, same product, different sources: last write wins', async () => {
    // Apple purchase
    local.store.mintEntitlement({
      productId,
      user: '0xAlice',
      expiresAt: new Date(Date.now() + 30 * 86400_000),
      source: 'apple',
      sourceId: 'apple_txn_1',
    });

    expect((await local.reader.getEntitlement(productId, '0xAlice'))!.source).toBe('apple');

    // Stripe purchase overwrites
    local.store.mintEntitlement({
      productId,
      user: '0xAlice',
      expiresAt: new Date(Date.now() + 365 * 86400_000),
      source: 'stripe',
      sourceId: 'stripe_sub_1',
    });

    const entitlement = await local.reader.getEntitlement(productId, '0xAlice');
    expect(entitlement!.source).toBe('stripe');
    expect(entitlement!.sourceId).toBe('stripe_sub_1');
  });

  it('different users from different stores are independent', async () => {
    local.store.mintEntitlement({
      productId,
      user: '0xAppleUser',
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'apple',
      sourceId: 'apple_txn',
    });

    local.store.mintEntitlement({
      productId,
      user: '0xStripeUser',
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'stripe_sub',
    });

    local.store.mintEntitlement({
      productId,
      user: '0xGoogleUser',
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'google',
      sourceId: 'google_txn',
    });

    const [apple, stripe, google] = await Promise.all([
      local.reader.getEntitlement(productId, '0xAppleUser'),
      local.reader.getEntitlement(productId, '0xStripeUser'),
      local.reader.getEntitlement(productId, '0xGoogleUser'),
    ]);

    expect(apple!.source).toBe('apple');
    expect(stripe!.source).toBe('stripe');
    expect(google!.source).toBe('google');
  });
});

describe('Large-scale stress', () => {
  it('100 users, 10 products: batch checks all correct', async () => {
    const local = createLocalChain();
    const products = Array.from({ length: 10 }, (_, i) => deriveProductIdHex(`stress-product-${i}`));
    const users = Array.from({ length: 100 }, (_, i) => `0xStress${i.toString().padStart(3, '0')}`);

    // Each user gets entitlements for products where (userIndex + productIndex) is even
    for (const [ui, user] of users.entries()) {
      for (const [pi, pid] of products.entries()) {
        if ((ui + pi) % 2 === 0) {
          local.store.mintEntitlement({
            productId: pid,
            user,
            expiresAt: new Date(Date.now() + 86400_000),
            source: 'platform',
            sourceId: `grant_${ui}_${pi}`,
          });
        }
      }
    }

    // Spot-check a few users via batch
    for (const ui of [0, 25, 50, 75, 99]) {
      const user = users[ui];
      const batch = await local.reader.checkEntitlements(products, user);

      for (const [pi, pid] of products.entries()) {
        const expected = (ui + pi) % 2 === 0;
        expect(batch.results[pid].entitled).toBe(expected);
      }
    }

    expect(local.store.entitlementCount).toBe(500); // 100*10/2
  });
});

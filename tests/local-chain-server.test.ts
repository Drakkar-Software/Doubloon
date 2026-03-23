/**
 * E2E: Local chain + Doubloon server integration.
 *
 * Validates the full flow: createLocalChain → createServer → mint → check → revoke.
 * No network, no blockchain — everything runs in-memory.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createLocalChain } from '@doubloon/chain-local';
import { createServer } from '@doubloon/server';
import { deriveProductIdHex } from '@doubloon/core';

describe('Local chain + server e2e', () => {
  const proMonthlyId = deriveProductIdHex('pro-monthly');
  const lifetimeId = deriveProductIdHex('lifetime-pass');
  const wallet = '0xAlice';

  let local: ReturnType<typeof createLocalChain>;
  let server: ReturnType<typeof createServer>;
  const mintFailures: Array<{ productId: string; error: string }> = [];

  beforeEach(() => {
    mintFailures.length = 0;
    local = createLocalChain();
    server = createServer({
      chain: {
        reader: local.reader,
        writer: local.writer,
        signer: local.signer,
      },
      bridges: {},
      onMintFailure: async (instruction, error) => {
        mintFailures.push({ productId: instruction.productId, error: error.message });
      },
    });
  });

  it('checks not_found for non-existent entitlement', async () => {
    const check = await server.checkEntitlement(proMonthlyId, wallet);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('not_found');
    expect(check.entitlement).toBeNull();
  });

  it('mints via store and checks via server', async () => {
    local.store.mintEntitlement({
      productId: proMonthlyId,
      user: wallet,
      expiresAt: new Date(Date.now() + 30 * 86400_000),
      source: 'stripe',
      sourceId: 'sub_1',
    });

    const check = await server.checkEntitlement(proMonthlyId, wallet);
    expect(check.entitled).toBe(true);
    expect(check.reason).toBe('active');
    expect(check.entitlement).not.toBeNull();
    expect(check.expiresAt).toBeInstanceOf(Date);
  });

  it('mints via writer.mintEntitlement and checks via server', async () => {
    await local.writer.mintEntitlement({
      productId: proMonthlyId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'apple',
      sourceId: 'txn_1',
      signer: local.signer.publicKey,
    });

    const check = await server.checkEntitlement(proMonthlyId, wallet);
    expect(check.entitled).toBe(true);
    expect(check.entitlement!.source).toBe('apple');
  });

  it('lifetime entitlement has no expiry', async () => {
    local.store.mintEntitlement({
      productId: lifetimeId,
      user: wallet,
      expiresAt: null,
      source: 'platform',
      sourceId: 'grant_1',
    });

    const check = await server.checkEntitlement(lifetimeId, wallet);
    expect(check.entitled).toBe(true);
    expect(check.expiresAt).toBeNull();
    expect(check.reason).toBe('active');
  });

  it('expired entitlement returns expired', async () => {
    local.store.mintEntitlement({
      productId: proMonthlyId,
      user: wallet,
      expiresAt: new Date(Date.now() - 1000),
      source: 'stripe',
      sourceId: 'sub_expired',
    });

    const check = await server.checkEntitlement(proMonthlyId, wallet);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('expired');
  });

  it('revocation flow: mint → revoke → check', async () => {
    local.store.mintEntitlement({
      productId: proMonthlyId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_1',
    });

    // Verify active
    const before = await server.checkEntitlement(proMonthlyId, wallet);
    expect(before.entitled).toBe(true);

    // Revoke
    local.store.revokeEntitlement({
      productId: proMonthlyId,
      user: wallet,
      revokedBy: 'admin',
    });

    // Verify revoked
    const after = await server.checkEntitlement(proMonthlyId, wallet);
    expect(after.entitled).toBe(false);
    expect(after.reason).toBe('revoked');
    expect(after.entitlement!.revokedBy).toBe('admin');
  });

  it('renewal flow: mint → expire → re-mint → check', async () => {
    // Initial mint (already expired)
    local.store.mintEntitlement({
      productId: proMonthlyId,
      user: wallet,
      expiresAt: new Date(Date.now() - 1000),
      source: 'stripe',
      sourceId: 'sub_1',
    });
    expect((await server.checkEntitlement(proMonthlyId, wallet)).entitled).toBe(false);

    // Re-mint (renew)
    local.store.mintEntitlement({
      productId: proMonthlyId,
      user: wallet,
      expiresAt: new Date(Date.now() + 30 * 86400_000),
      source: 'stripe',
      sourceId: 'sub_1_renewal',
    });

    const after = await server.checkEntitlement(proMonthlyId, wallet);
    expect(after.entitled).toBe(true);
    expect(after.entitlement!.sourceId).toBe('sub_1_renewal');
  });

  it('batch check returns results for all products', async () => {
    local.store.mintEntitlement({
      productId: proMonthlyId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_1',
    });

    const batch = await server.checkEntitlements([proMonthlyId, lifetimeId], wallet);
    expect(batch.user).toBe(wallet);
    expect(batch.results[proMonthlyId].entitled).toBe(true);
    expect(batch.results[lifetimeId].entitled).toBe(false);
    expect(batch.results[lifetimeId].reason).toBe('not_found');
  });

  it('batch check with empty list', async () => {
    const batch = await server.checkEntitlements([], wallet);
    expect(Object.keys(batch.results)).toHaveLength(0);
  });

  it('processInstruction mints via server pipeline', async () => {
    const notification = {
      id: 'notif_1',
      type: 'initial_purchase' as const,
      store: 'stripe' as const,
      environment: 'production' as const,
      productId: proMonthlyId,
      userWallet: wallet,
      originalTransactionId: 'txn_1',
      expiresAt: new Date(Date.now() + 86400_000),
      autoRenew: false,
      storeTimestamp: new Date(),
      receivedTimestamp: new Date(),
      deduplicationKey: 'dedup_1',
      raw: {},
    };

    await server.processInstruction(
      {
        productId: proMonthlyId,
        user: wallet,
        expiresAt: new Date(Date.now() + 86400_000),
        source: 'stripe',
        sourceId: 'sub_1',
      },
      notification,
      'stripe',
    );

    const check = await server.checkEntitlement(proMonthlyId, wallet);
    expect(check.entitled).toBe(true);
  });

  it('processInstruction revokes via server pipeline', async () => {
    // First mint
    local.store.mintEntitlement({
      productId: proMonthlyId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_1',
    });

    const notification = {
      id: 'notif_revoke',
      type: 'revocation' as const,
      store: 'stripe' as const,
      environment: 'production' as const,
      productId: proMonthlyId,
      userWallet: wallet,
      originalTransactionId: 'txn_1',
      expiresAt: null,
      autoRenew: false,
      storeTimestamp: new Date(),
      receivedTimestamp: new Date(),
      deduplicationKey: 'dedup_revoke',
      raw: {},
    };

    await server.processInstruction(
      {
        productId: proMonthlyId,
        user: wallet,
        reason: 'refund',
      },
      notification,
      'stripe',
    );

    const check = await server.checkEntitlement(proMonthlyId, wallet);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('revoked');
  });

  it('multi-user isolation: users see only their entitlements', async () => {
    const bob = '0xBob';

    local.store.mintEntitlement({
      productId: proMonthlyId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_alice',
    });

    local.store.mintEntitlement({
      productId: lifetimeId,
      user: bob,
      expiresAt: null,
      source: 'platform',
      sourceId: 'grant_bob',
    });

    // Alice has pro-monthly but not lifetime
    expect((await server.checkEntitlement(proMonthlyId, wallet)).entitled).toBe(true);
    expect((await server.checkEntitlement(lifetimeId, wallet)).entitled).toBe(false);

    // Bob has lifetime but not pro-monthly
    expect((await server.checkEntitlement(proMonthlyId, bob)).entitled).toBe(false);
    expect((await server.checkEntitlement(lifetimeId, bob)).entitled).toBe(true);
  });

  it('frozen platform rejects mints via writer', async () => {
    const frozenLocal = createLocalChain();
    // Access the store's internal platform state
    const frozenStore = new (await import('@doubloon/chain-local')).LocalChainStore({ frozen: true });
    const frozenWriter = new (await import('@doubloon/chain-local')).LocalChainWriter({ store: frozenStore });

    await expect(
      frozenWriter.mintEntitlement({
        productId: proMonthlyId,
        user: wallet,
        expiresAt: null,
        source: 'platform',
        sourceId: 'test',
        signer: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'PRODUCT_FROZEN' });
  });

  it('product metadata round-trip: register → read', async () => {
    await local.writer.registerProduct({
      productId: proMonthlyId,
      name: 'Pro Monthly',
      metadataUri: 'https://example.com/meta.json',
      defaultDuration: 30 * 86400,
      signer: local.signer.publicKey,
    });

    const product = await local.reader.getProduct(proMonthlyId);
    expect(product).not.toBeNull();
    expect(product!.name).toBe('Pro Monthly');
    expect(product!.metadataUri).toBe('https://example.com/meta.json');
    expect(product!.defaultDuration).toBe(30 * 86400);
    expect(product!.active).toBe(true);
    expect(product!.frozen).toBe(false);
  });

  it('store.clear resets all state', async () => {
    local.store.mintEntitlement({
      productId: proMonthlyId,
      user: wallet,
      expiresAt: null,
      source: 'platform',
      sourceId: 'test',
    });

    expect(local.store.entitlementCount).toBe(1);
    local.store.clear();
    expect(local.store.entitlementCount).toBe(0);

    const check = await server.checkEntitlement(proMonthlyId, wallet);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('not_found');
  });
});

/**
 * E2E: Reconciliation engine against local chain.
 *
 * Tests that the reconciliation runner detects drift between external store
 * state and on-chain state, and corrects it by minting or revoking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLocalChain } from '@doubloon/chain-local';
import { createReconciliationRunner } from '@doubloon/server';
import type { ReconciliationItem } from '@doubloon/server';
import { deriveProductIdHex } from '@doubloon/core';
import type { Entitlement, MintInstruction, RevokeInstruction } from '@doubloon/core';

describe('Reconciliation e2e', () => {
  const productId = deriveProductIdHex('pro-monthly');
  const wallet = '0xAlice';

  let local: ReturnType<typeof createLocalChain>;

  beforeEach(() => {
    local = createLocalChain();
  });

  function makeBridge(opts: {
    drift: boolean;
    instruction: MintInstruction | RevokeInstruction | null;
  }) {
    return {
      reconcile: vi.fn(async () => ({
        drift: opts.drift,
        instruction: opts.instruction,
      })),
    };
  }

  it('no drift: reports checked but no corrections', async () => {
    local.store.mintEntitlement({
      productId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_1',
    });

    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
    });

    const items: ReconciliationItem[] = [{
      subscriptionId: 'sub_1',
      bridge: makeBridge({ drift: false, instruction: null }),
      currentState: local.store.getEntitlement(productId, wallet),
    }];

    const report = await runner.run(items);
    expect(report.checked).toBe(1);
    expect(report.drifted).toBe(0);
    expect(report.minted).toBe(0);
    expect(report.revoked).toBe(0);
    expect(report.errors).toHaveLength(0);
  });

  it('drift with mint: creates missing on-chain entitlement', async () => {
    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
    });

    const items: ReconciliationItem[] = [{
      subscriptionId: 'sub_missing',
      bridge: makeBridge({
        drift: true,
        instruction: {
          productId,
          user: wallet,
          expiresAt: new Date(Date.now() + 30 * 86400_000),
          source: 'stripe',
          sourceId: 'sub_missing',
        },
      }),
      currentState: null, // no on-chain state
    }];

    const report = await runner.run(items);
    expect(report.checked).toBe(1);
    expect(report.drifted).toBe(1);
    expect(report.minted).toBe(1);

    // Verify on-chain
    const check = await local.reader.checkEntitlement(productId, wallet);
    expect(check.entitled).toBe(true);
  });

  it('drift with revoke: removes stale on-chain entitlement', async () => {
    local.store.mintEntitlement({
      productId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_stale',
    });

    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
    });

    const items: ReconciliationItem[] = [{
      subscriptionId: 'sub_stale',
      bridge: makeBridge({
        drift: true,
        instruction: {
          productId,
          user: wallet,
          reason: 'store_cancelled',
        },
      }),
      currentState: local.store.getEntitlement(productId, wallet),
    }];

    const report = await runner.run(items);
    expect(report.drifted).toBe(1);
    expect(report.revoked).toBe(1);

    const check = await local.reader.checkEntitlement(productId, wallet);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('revoked');
  });

  it('drift detected but null instruction: counts as drift, no action', async () => {
    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
    });

    const items: ReconciliationItem[] = [{
      subscriptionId: 'sub_drift_noop',
      bridge: makeBridge({ drift: true, instruction: null }),
      currentState: null,
    }];

    const report = await runner.run(items);
    expect(report.drifted).toBe(1);
    expect(report.minted).toBe(0);
    expect(report.revoked).toBe(0);
  });

  it('batch reconciliation across multiple subscriptions', async () => {
    const product2 = deriveProductIdHex('pro-yearly');

    // Alice has pro-monthly on-chain but store says cancelled
    local.store.mintEntitlement({
      productId,
      user: wallet,
      expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe',
      sourceId: 'sub_monthly',
    });

    // Bob is missing pro-yearly on-chain but store says active
    const bob = '0xBob';

    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
    });

    const items: ReconciliationItem[] = [
      {
        subscriptionId: 'sub_monthly',
        bridge: makeBridge({
          drift: true,
          instruction: { productId, user: wallet, reason: 'cancelled' },
        }),
        currentState: local.store.getEntitlement(productId, wallet),
      },
      {
        subscriptionId: 'sub_yearly_bob',
        bridge: makeBridge({
          drift: true,
          instruction: {
            productId: product2,
            user: bob,
            expiresAt: new Date(Date.now() + 365 * 86400_000),
            source: 'stripe',
            sourceId: 'sub_yearly_bob',
          },
        }),
        currentState: null,
      },
      {
        subscriptionId: 'sub_ok',
        bridge: makeBridge({ drift: false, instruction: null }),
        currentState: null,
      },
    ];

    const report = await runner.run(items);
    expect(report.checked).toBe(3);
    expect(report.drifted).toBe(2);
    expect(report.minted).toBe(1);
    expect(report.revoked).toBe(1);
    expect(report.errors).toHaveLength(0);

    // Alice: revoked
    expect((await local.reader.checkEntitlement(productId, wallet)).entitled).toBe(false);
    // Bob: minted
    expect((await local.reader.checkEntitlement(product2, bob)).entitled).toBe(true);
  });

  it('reconciliation error on one item does not block others', async () => {
    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
    });

    const failingBridge = {
      reconcile: vi.fn(async () => {
        throw new Error('Bridge API timeout');
      }),
    };

    const items: ReconciliationItem[] = [
      {
        subscriptionId: 'sub_fail',
        bridge: failingBridge,
        currentState: null,
      },
      {
        subscriptionId: 'sub_ok',
        bridge: makeBridge({
          drift: true,
          instruction: {
            productId,
            user: wallet,
            expiresAt: new Date(Date.now() + 86400_000),
            source: 'stripe',
            sourceId: 'sub_ok',
          },
        }),
        currentState: null,
      },
    ];

    const report = await runner.run(items);
    expect(report.checked).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].subscriptionId).toBe('sub_fail');
    expect(report.minted).toBe(1); // second item succeeded
  });
});

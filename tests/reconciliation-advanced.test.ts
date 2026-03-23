/**
 * E2E: Reconciliation runner — mixed success/failure, large batches,
 * concurrent drift detection, report accuracy.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReconciliationRunner } from '@doubloon/server';
import { createLocalChain } from '@doubloon/chain-local';
import { deriveProductIdHex } from '@doubloon/core';
import type { MintInstruction, RevokeInstruction, Entitlement, Logger } from '@doubloon/core';

function makeMintInstruction(pid: string, user: string): MintInstruction {
  return { productId: pid, user, expiresAt: new Date(Date.now() + 86400_000), source: 'platform', sourceId: 'recon' };
}

function makeRevokeInstruction(pid: string, user: string): RevokeInstruction {
  return { productId: pid, user, reason: 'expired' };
}

describe('Reconciliation runner — advanced', () => {
  it('20 items with 1 error: error does not block remaining', async () => {
    const local = createLocalChain();
    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
      mintRetry: { maxRetries: 1, baseDelayMs: 0 },
    });

    const items = Array.from({ length: 20 }, (_, idx) => ({
      subscriptionId: `sub_${idx}`,
      bridge: {
        reconcile: vi.fn().mockImplementation(async () => {
          if (idx === 10) throw new Error('Bridge API timeout');
          if (idx < 5) return { drift: true, instruction: makeMintInstruction(deriveProductIdHex(`product-${idx}`), `user_${idx}`) };
          return { drift: false, instruction: null };
        }),
      },
      currentState: null,
    }));

    const report = await runner.run(items);
    expect(report.checked).toBe(20);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].subscriptionId).toBe('sub_10');
    expect(report.drifted).toBe(5);
    expect(report.minted).toBe(5);
  });

  it('mix of mints and revokes in single batch', async () => {
    const local = createLocalChain();
    const pid1 = deriveProductIdHex('mint-prod');
    const pid2 = deriveProductIdHex('revoke-prod');

    // Pre-mint for revocation target
    local.store.mintEntitlement({ productId: pid2, user: 'u2', expiresAt: null, source: 'platform', sourceId: 's' });

    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
    });

    const items = [
      {
        subscriptionId: 'sub_mint',
        bridge: { reconcile: async () => ({ drift: true, instruction: makeMintInstruction(pid1, 'u1') }) },
        currentState: null,
      },
      {
        subscriptionId: 'sub_revoke',
        bridge: { reconcile: async () => ({ drift: true, instruction: makeRevokeInstruction(pid2, 'u2') }) },
        currentState: { productId: pid2, user: 'u2', active: true } as any,
      },
      {
        subscriptionId: 'sub_nodrift',
        bridge: { reconcile: async () => ({ drift: false, instruction: null }) },
        currentState: null,
      },
    ];

    const report = await runner.run(items);
    expect(report.checked).toBe(3);
    expect(report.drifted).toBe(2);
    expect(report.minted).toBe(1);
    expect(report.revoked).toBe(1);
    expect(report.errors).toHaveLength(0);

    // Verify chain state
    const check1 = await local.reader.checkEntitlement(pid1, 'u1');
    expect(check1.entitled).toBe(true);

    const check2 = await local.reader.checkEntitlement(pid2, 'u2');
    expect(check2.entitled).toBe(false);
  });

  it('drift=true but instruction=null → counts as drift, no action', async () => {
    const local = createLocalChain();
    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
    });

    const report = await runner.run([{
      subscriptionId: 'sub_null',
      bridge: { reconcile: async () => ({ drift: true, instruction: null }) },
      currentState: null,
    }]);

    expect(report.drifted).toBe(1);
    expect(report.minted).toBe(0);
    expect(report.revoked).toBe(0);
  });

  it('multiple errors accumulated correctly', async () => {
    const local = createLocalChain();
    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
    });

    const items = Array.from({ length: 5 }, (_, i) => ({
      subscriptionId: `err_${i}`,
      bridge: {
        reconcile: async () => {
          if (i % 2 === 0) throw new Error(`Error ${i}`);
          return { drift: false, instruction: null };
        },
      },
      currentState: null,
    }));

    const report = await runner.run(items);
    expect(report.checked).toBe(5);
    expect(report.errors).toHaveLength(3); // items 0, 2, 4
    expect(report.errors.map(e => e.subscriptionId)).toEqual(['err_0', 'err_2', 'err_4']);
  });

  it('logger records mints and revokes', async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const local = createLocalChain();
    const pid = deriveProductIdHex('log-test');

    local.store.mintEntitlement({ productId: pid, user: 'u1', expiresAt: null, source: 'platform', sourceId: 's' });

    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
      logger,
    });

    await runner.run([
      {
        subscriptionId: 'sub_log_mint',
        bridge: { reconcile: async () => ({ drift: true, instruction: makeMintInstruction(deriveProductIdHex('new'), 'u2') }) },
        currentState: null,
      },
      {
        subscriptionId: 'sub_log_revoke',
        bridge: { reconcile: async () => ({ drift: true, instruction: makeRevokeInstruction(pid, 'u1') }) },
        currentState: { productId: pid, user: 'u1', active: true } as any,
      },
    ]);

    const infoCalls = (logger.info as any).mock.calls.map((c: any) => c[0]);
    expect(infoCalls).toContain('Reconciliation: minted');
    expect(infoCalls).toContain('Reconciliation: revoked');
  });

  it('empty items → zero report', async () => {
    const local = createLocalChain();
    const runner = createReconciliationRunner({
      writer: local.writer,
      signer: local.signer,
    });

    const report = await runner.run([]);
    expect(report.checked).toBe(0);
    expect(report.drifted).toBe(0);
    expect(report.minted).toBe(0);
    expect(report.revoked).toBe(0);
    expect(report.errors).toHaveLength(0);
  });
});

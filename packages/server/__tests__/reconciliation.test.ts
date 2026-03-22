import { describe, it, expect, vi } from 'vitest';
import { createReconciliationRunner } from '../src/reconciliation.js';

describe('createReconciliationRunner', () => {
  it('reports no drift when all items match', async () => {
    const runner = createReconciliationRunner({
      writer: { mintEntitlement: vi.fn(async () => 'tx') },
      signer: { signAndSend: vi.fn(async () => 'sig'), publicKey: 'signer' },
    });

    const report = await runner.run([
      {
        subscriptionId: 'sub1',
        bridge: { reconcile: vi.fn(async () => ({ drift: false, instruction: null })) },
        currentState: null,
      },
    ]);

    expect(report.checked).toBe(1);
    expect(report.drifted).toBe(0);
  });

  it('mints when drift detected with MintInstruction', async () => {
    const runner = createReconciliationRunner({
      writer: { mintEntitlement: vi.fn(async () => 'tx') },
      signer: { signAndSend: vi.fn(async () => 'sig'), publicKey: 'signer' },
      mintRetry: { baseDelayMs: 10 },
    });

    const report = await runner.run([
      {
        subscriptionId: 'sub1',
        bridge: {
          reconcile: vi.fn(async () => ({
            drift: true,
            instruction: {
              productId: 'p', user: 'w', expiresAt: null,
              source: 'apple' as const, sourceId: 'tx1',
            },
          })),
        },
        currentState: null,
      },
    ]);

    expect(report.drifted).toBe(1);
    expect(report.minted).toBe(1);
  });

  it('captures errors without crashing', async () => {
    const runner = createReconciliationRunner({
      writer: { mintEntitlement: vi.fn(async () => 'tx') },
      signer: { signAndSend: vi.fn(async () => 'sig'), publicKey: 'signer' },
    });

    const report = await runner.run([
      {
        subscriptionId: 'sub1',
        bridge: { reconcile: vi.fn(async () => { throw new Error('API down'); }) },
        currentState: null,
      },
      {
        subscriptionId: 'sub2',
        bridge: { reconcile: vi.fn(async () => ({ drift: false, instruction: null })) },
        currentState: null,
      },
    ]);

    expect(report.checked).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].subscriptionId).toBe('sub1');
  });
});

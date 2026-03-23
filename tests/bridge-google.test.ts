/**
 * E2E: Google Play bridge — RTDN parsing, notification type mapping,
 * all 13 notification codes, test notifications, wallet/product resolution,
 * acknowledgment logic, autoRenew computation, instruction routing.
 */
import { describe, it, expect, vi } from 'vitest';
import { GoogleBridge, mapGoogleNotificationType, computeGoogleDeduplicationKey } from '@doubloon/bridge-google';
import { DoubloonError } from '@doubloon/core';

function makeGoogleBridge(overrides?: {
  resolveProductId?: (store: string, sku: string) => Promise<string | null>;
  resolveWallet?: (store: string, userId: string) => Promise<string | null>;
}) {
  return new GoogleBridge({
    productResolver: {
      resolveProductId: overrides?.resolveProductId ?? (async () => 'on-chain-pid'),
      resolveStoreSku: async () => null,
    },
    walletResolver: {
      resolveWallet: overrides?.resolveWallet ?? (async () => '0xAlice'),
      linkWallet: async () => {},
    },
  });
}

function makeRTDN(notificationType: number, overrides?: Record<string, unknown>) {
  return JSON.stringify({
    version: '1.0',
    packageName: 'com.test.app',
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType,
      purchaseToken: 'GPA.token.abc',
      subscriptionId: 'premium_monthly',
    },
    ...overrides,
  });
}

describe('Google notification type mapping (all 13 codes)', () => {
  const cases: Array<[number, string]> = [
    [1, 'billing_recovery'],       // RECOVERED
    [2, 'renewal'],                // RENEWED
    [3, 'cancellation'],           // CANCELED
    [4, 'initial_purchase'],       // PURCHASED
    [5, 'billing_retry_start'],    // ON_HOLD
    [6, 'grace_period_start'],     // IN_GRACE_PERIOD
    [7, 'renewal'],                // RESTARTED
    [8, 'price_increase_consent'], // PRICE_CHANGE_CONFIRMED
    [9, 'renewal'],                // DEFERRED
    [10, 'pause'],                 // PAUSED
    [11, 'resume'],                // PAUSE_SCHEDULE_CHANGED
    [12, 'revocation'],            // REVOKED
    [13, 'expiration'],            // EXPIRED
    [99, 'test'],                  // Unknown
    [0, 'test'],                   // Unknown
  ];

  for (const [code, expected] of cases) {
    it(`code ${code} → ${expected}`, () => {
      expect(mapGoogleNotificationType(code)).toBe(expected);
    });
  }
});

describe('Google deduplication key', () => {
  it('includes type, purchaseToken, and notificationType', () => {
    const key = computeGoogleDeduplicationKey('renewal', 'GPA.token.abc', 2);
    expect(key).toBe('google:renewal:GPA.token.abc:2');
  });
});

describe('GoogleBridge.handleNotification', () => {
  it('processes initial_purchase (code 4) with mint instruction', async () => {
    const bridge = makeGoogleBridge();
    const result = await bridge.handleNotification({}, Buffer.from(makeRTDN(4)));

    expect(result.notification.type).toBe('initial_purchase');
    expect(result.notification.store).toBe('google');
    expect(result.instruction).not.toBeNull();
    expect(result.instruction!).toHaveProperty('source', 'google');
    expect(result.requiresAcknowledgment).toBe(true);
  });

  it('processes renewal (code 2) with mint instruction', async () => {
    const bridge = makeGoogleBridge();
    const result = await bridge.handleNotification({}, Buffer.from(makeRTDN(2)));

    expect(result.notification.type).toBe('renewal');
    expect(result.instruction).not.toBeNull();
    expect(result.instruction!).toHaveProperty('source', 'google');
    expect(result.requiresAcknowledgment).toBe(false);
  });

  it('processes revocation (code 12) with revoke instruction', async () => {
    const bridge = makeGoogleBridge();
    const result = await bridge.handleNotification({}, Buffer.from(makeRTDN(12)));

    expect(result.notification.type).toBe('revocation');
    expect(result.instruction).toHaveProperty('reason', 'google:revocation');
  });

  it('processes expiration (code 13) with revoke instruction', async () => {
    const bridge = makeGoogleBridge();
    const result = await bridge.handleNotification({}, Buffer.from(makeRTDN(13)));

    expect(result.instruction).toHaveProperty('reason', 'google:expiration');
  });

  it('processes cancellation (code 3) with null instruction', async () => {
    const bridge = makeGoogleBridge();
    const result = await bridge.handleNotification({}, Buffer.from(makeRTDN(3)));

    expect(result.notification.type).toBe('cancellation');
    expect(result.instruction).toBeNull();
  });

  it('processes pause (code 10) with null instruction', async () => {
    const bridge = makeGoogleBridge();
    const result = await bridge.handleNotification({}, Buffer.from(makeRTDN(10)));

    expect(result.notification.type).toBe('pause');
    expect(result.instruction).toBeNull();
  });

  it('processes resume (code 11) with mint instruction', async () => {
    const bridge = makeGoogleBridge();
    const result = await bridge.handleNotification({}, Buffer.from(makeRTDN(11)));

    expect(result.notification.type).toBe('resume');
    expect(result.instruction).not.toBeNull();
  });

  it('processes billing_recovery (code 1) with mint instruction', async () => {
    const bridge = makeGoogleBridge();
    const result = await bridge.handleNotification({}, Buffer.from(makeRTDN(1)));

    expect(result.notification.type).toBe('billing_recovery');
    expect(result.instruction).not.toBeNull();
  });

  it('autoRenew false for codes 3, 10, 12, 13', async () => {
    const bridge = makeGoogleBridge();
    for (const code of [3, 10, 12, 13]) {
      const result = await bridge.handleNotification({}, Buffer.from(makeRTDN(code)));
      expect(result.notification.autoRenew).toBe(false);
    }
  });

  it('autoRenew true for other codes (1, 2, 4, 5, 6, 7, 8, 9, 11)', async () => {
    const bridge = makeGoogleBridge();
    for (const code of [1, 2, 4, 5, 6, 7, 8, 9, 11]) {
      const result = await bridge.handleNotification({}, Buffer.from(makeRTDN(code)));
      expect(result.notification.autoRenew).toBe(true);
    }
  });

  it('handles test notification (no subscription)', async () => {
    const bridge = makeGoogleBridge();
    const body = JSON.stringify({
      version: '1.0',
      packageName: 'com.test.app',
      eventTimeMillis: String(Date.now()),
      testNotification: { version: '1.0' },
    });

    const result = await bridge.handleNotification({}, Buffer.from(body));
    expect(result.notification.type).toBe('test');
    expect(result.instruction).toBeNull();
    expect(result.requiresAcknowledgment).toBe(false);
  });

  it('throws INVALID_RECEIPT for non-JSON body', async () => {
    const bridge = makeGoogleBridge();
    await expect(
      bridge.handleNotification({}, Buffer.from('not json')),
    ).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  });

  it('throws INVALID_RECEIPT for missing packageName', async () => {
    const bridge = makeGoogleBridge();
    const body = JSON.stringify({ subscriptionNotification: {} });
    await expect(
      bridge.handleNotification({}, Buffer.from(body)),
    ).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  });

  it('throws INVALID_RECEIPT when neither subscription nor test notification', async () => {
    const bridge = makeGoogleBridge();
    const body = JSON.stringify({
      version: '1.0',
      packageName: 'com.test.app',
      eventTimeMillis: String(Date.now()),
    });

    await expect(
      bridge.handleNotification({}, Buffer.from(body)),
    ).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  });

  it('throws PRODUCT_NOT_MAPPED for unknown subscription ID', async () => {
    const bridge = makeGoogleBridge({
      resolveProductId: async () => null,
    });

    await expect(
      bridge.handleNotification({}, Buffer.from(makeRTDN(4))),
    ).rejects.toMatchObject({ code: 'PRODUCT_NOT_MAPPED' });
  });

  it('throws WALLET_NOT_LINKED for unresolvable purchase token', async () => {
    const bridge = makeGoogleBridge({
      resolveWallet: async () => null,
    });

    await expect(
      bridge.handleNotification({}, Buffer.from(makeRTDN(4))),
    ).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
  });
});

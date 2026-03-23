/**
 * E2E: Apple bridge — notification type mapping, wallet resolution fallback,
 * instruction routing, empty notifications, deduplication keys, and reconcile.
 */
import { describe, it, expect, vi } from 'vitest';
import { AppleBridge, mapAppleNotificationType, computeAppleDeduplicationKey } from '@doubloon/bridge-apple';
import { DoubloonError } from '@doubloon/core';

function makeAppleBridge(overrides?: {
  resolveProductId?: (store: string, sku: string) => Promise<string | null>;
  resolveWallet?: (store: string, userId: string) => Promise<string | null>;
}) {
  return new AppleBridge({
    environment: 'sandbox',
    bundleId: 'com.test.app',
    issuerId: 'issuer-1',
    keyId: 'key-1',
    privateKey: 'test-private-key',
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

describe('Apple notification type mapping', () => {
  const cases: Array<[string, string | undefined, string]> = [
    ['SUBSCRIBED', undefined, 'initial_purchase'],
    ['SUBSCRIBED', 'RESUBSCRIBE', 'renewal'],
    ['DID_RENEW', undefined, 'renewal'],
    ['DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED', 'cancellation'],
    ['DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_ENABLED', 'uncancellation'],
    ['DID_CHANGE_RENEWAL_INFO', 'DOWNGRADE', 'plan_change'],
    ['DID_CHANGE_RENEWAL_INFO', 'UPGRADE', 'plan_change'],
    ['DID_CHANGE_RENEWAL_INFO', 'AUTO_RENEW_DISABLED', 'cancellation'],
    ['DID_CHANGE_RENEWAL_INFO', 'AUTO_RENEW_ENABLED', 'uncancellation'],
    ['DID_CHANGE_RENEWAL_INFO', undefined, 'plan_change'],
    ['EXPIRED', undefined, 'expiration'],
    ['DID_FAIL_TO_RENEW', 'GRACE_PERIOD', 'grace_period_start'],
    ['DID_FAIL_TO_RENEW', undefined, 'billing_retry_start'],
    ['GRACE_PERIOD_EXPIRED', undefined, 'expiration'],
    ['REFUND', undefined, 'refund'],
    ['REFUND_DECLINED', undefined, 'billing_recovery'],
    ['REFUND_REVERSED', undefined, 'billing_recovery'],
    ['REVOKE', undefined, 'revocation'],
    ['RENEWAL_EXTENDED', undefined, 'renewal'],
    ['PRICE_INCREASE', undefined, 'price_increase_consent'],
    ['OFFER_REDEEMED', undefined, 'offer_redeemed'],
    ['TEST', undefined, 'test'],
    ['UNKNOWN_TYPE', undefined, 'test'],
  ];

  for (const [appleType, subtype, expected] of cases) {
    it(`${appleType}/${subtype ?? 'none'} → ${expected}`, () => {
      expect(mapAppleNotificationType(appleType, subtype)).toBe(expected);
    });
  }
});

describe('Apple deduplication key', () => {
  it('includes type, originalTransactionId, transactionId, signedDate', () => {
    const key = computeAppleDeduplicationKey('renewal', {
      originalTransactionId: 'orig-1',
      transactionId: 'txn-1',
      signedDate: 1700000000,
    });
    expect(key).toBe('apple:renewal:orig-1:txn-1:1700000000');
  });

  it('handles missing fields gracefully', () => {
    const key = computeAppleDeduplicationKey('test', {});
    expect(key).toBe('apple:test:::');
  });
});

describe('AppleBridge.handleNotification', () => {
  it('processes a valid initial_purchase', async () => {
    const bridge = makeAppleBridge();
    const body = Buffer.from(JSON.stringify({
      notificationType: 'SUBSCRIBED',
      transactionInfo: {
        productId: 'com.test.premium',
        transactionId: 'txn-100',
        originalTransactionId: 'txn-100',
        expiresDate: Date.now() + 86400_000,
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.type).toBe('initial_purchase');
    expect(result.notification.store).toBe('apple');
    expect(result.instruction).not.toBeNull();
    expect(result.instruction!).toHaveProperty('source', 'apple');
  });

  it('returns null instruction for cancellation type', async () => {
    const bridge = makeAppleBridge();
    const body = Buffer.from(JSON.stringify({
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      subtype: 'AUTO_RENEW_DISABLED',
      transactionInfo: {
        productId: 'com.test.premium',
        transactionId: 'txn-200',
        originalTransactionId: 'txn-200',
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.type).toBe('cancellation');
    expect(result.instruction).toBeNull();
  });

  it('returns revoke instruction for REVOKE', async () => {
    const bridge = makeAppleBridge();
    const body = Buffer.from(JSON.stringify({
      notificationType: 'REVOKE',
      transactionInfo: {
        productId: 'com.test.premium',
        transactionId: 'txn-300',
        originalTransactionId: 'txn-300',
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.instruction).not.toBeNull();
    expect(result.instruction!).toHaveProperty('reason', 'apple:revocation');
  });

  it('returns revoke instruction for REFUND', async () => {
    const bridge = makeAppleBridge();
    const body = Buffer.from(JSON.stringify({
      notificationType: 'REFUND',
      transactionInfo: {
        productId: 'com.test.premium',
        transactionId: 'txn-400',
        originalTransactionId: 'txn-400',
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.instruction).toHaveProperty('reason', 'apple:refund');
  });

  it('handles missing transactionInfo (empty notification)', async () => {
    const bridge = makeAppleBridge();
    const body = Buffer.from(JSON.stringify({
      notificationType: 'TEST',
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.productId).toBe('');
    expect(result.instruction).toBeNull();
  });

  it('throws PRODUCT_NOT_MAPPED for unknown Apple product ID', async () => {
    const bridge = makeAppleBridge({
      resolveProductId: async () => null,
    });
    const body = Buffer.from(JSON.stringify({
      notificationType: 'SUBSCRIBED',
      transactionInfo: { productId: 'unknown.sku' },
    }));

    await expect(bridge.handleNotification({}, body)).rejects.toMatchObject({
      code: 'PRODUCT_NOT_MAPPED',
    });
  });

  it('throws INVALID_RECEIPT for non-JSON body', async () => {
    const bridge = makeAppleBridge();
    await expect(
      bridge.handleNotification({}, Buffer.from('not json')),
    ).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  });

  it('throws INVALID_RECEIPT for missing notificationType', async () => {
    const bridge = makeAppleBridge();
    await expect(
      bridge.handleNotification({}, Buffer.from('{}')),
    ).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  });

  it('wallet resolution: tries appAccountToken first, then originalTransactionId', async () => {
    const resolvedCalls: string[] = [];
    const bridge = makeAppleBridge({
      resolveWallet: async (_store, userId) => {
        resolvedCalls.push(userId);
        if (userId === 'app-token-123') return '0xFromAppToken';
        return null;
      },
    });

    const body = Buffer.from(JSON.stringify({
      notificationType: 'SUBSCRIBED',
      transactionInfo: {
        productId: 'sku',
        appAccountToken: 'app-token-123',
        originalTransactionId: 'orig-txn',
        transactionId: 'txn',
      },
    }));

    const result = await bridge.handleNotification({}, body);
    // Should resolve from appAccountToken first
    expect(resolvedCalls[0]).toBe('app-token-123');
    expect(result.notification.userWallet).toBe('0xFromAppToken');
  });

  it('wallet resolution falls back to originalTransactionId', async () => {
    const bridge = makeAppleBridge({
      resolveWallet: async (_store, userId) => {
        if (userId === 'orig-txn') return '0xFromOrig';
        return null;
      },
    });

    const body = Buffer.from(JSON.stringify({
      notificationType: 'SUBSCRIBED',
      transactionInfo: {
        productId: 'sku',
        appAccountToken: 'unknown-token',
        originalTransactionId: 'orig-txn',
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.userWallet).toBe('0xFromOrig');
  });

  it('null wallet produces null instruction', async () => {
    const bridge = makeAppleBridge({
      resolveWallet: async () => null,
    });

    const body = Buffer.from(JSON.stringify({
      notificationType: 'SUBSCRIBED',
      transactionInfo: {
        productId: 'sku',
        transactionId: 'txn',
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.instruction).toBeNull();
  });

  it('autoRenew is true for non-cancellation with autoRenewStatus != 0', async () => {
    const bridge = makeAppleBridge();
    const body = Buffer.from(JSON.stringify({
      notificationType: 'DID_RENEW',
      transactionInfo: {
        productId: 'sku',
        transactionId: 'txn',
        originalTransactionId: 'txn',
        autoRenewStatus: 1,
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.autoRenew).toBe(true);
  });

  it('autoRenew is false for cancellation type', async () => {
    const bridge = makeAppleBridge();
    const body = Buffer.from(JSON.stringify({
      notificationType: 'EXPIRED',
      transactionInfo: {
        productId: 'sku',
        transactionId: 'txn',
        originalTransactionId: 'txn',
        autoRenewStatus: 1,
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.autoRenew).toBe(false);
  });
});

describe('AppleBridge.reconcile', () => {
  it('returns no drift (placeholder implementation)', async () => {
    const bridge = makeAppleBridge();
    const result = await bridge.reconcile('orig-txn-1', null);
    expect(result.drift).toBe(false);
    expect(result.instruction).toBeNull();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { GoogleBridge } from '../src/bridge.js';
import type { StoreProductResolver } from '@doubloon/storage';
import type { WalletResolver } from '@doubloon/core';

function makeMockResolver(): StoreProductResolver {
  return {
    resolveProductId: vi.fn(async (_store, sku) => {
      if (sku === 'com.app.pro.monthly') return 'b'.repeat(64);
      return null;
    }),
    resolveStoreSku: vi.fn(async () => ['com.app.pro.monthly']),
  };
}

function makeMockWalletResolver(): WalletResolver {
  return {
    resolveWallet: vi.fn(async () => '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'),
    linkWallet: vi.fn(async () => {}),
  };
}

const emptyHeaders: Record<string, string> = {};

function toBody(str: string): Buffer {
  return Buffer.from(str, 'utf-8');
}

function makeRTDN(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: '1.0',
    packageName: 'com.app',
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType: 4, // PURCHASED
      purchaseToken: 'token-abc',
      subscriptionId: 'com.app.pro.monthly',
    },
    ...overrides,
  });
}

describe('GoogleBridge', () => {
  it('handles initial purchase (notificationType 4)', async () => {
    const bridge = new GoogleBridge({
      packageName: 'com.app',
      serviceAccountKey: '{}',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const result = await bridge.handleNotification(emptyHeaders, toBody(makeRTDN()));
    expect(result.notification.type).toBe('initial_purchase');
    expect(result.notification.store).toBe('google');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).source).toBe('google');
    expect((result.instruction as any).productId).toBe('b'.repeat(64));
    expect(result.requiresAcknowledgment).toBe(true);
  });

  it('handles renewal (notificationType 2)', async () => {
    const bridge = new GoogleBridge({
      packageName: 'com.app',
      serviceAccountKey: '{}',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const msg = makeRTDN({
      subscriptionNotification: {
        version: '1.0',
        notificationType: 2, // RENEWED
        purchaseToken: 'token-abc',
        subscriptionId: 'com.app.pro.monthly',
      },
    });

    const result = await bridge.handleNotification(emptyHeaders, toBody(msg));
    expect(result.notification.type).toBe('renewal');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).source).toBe('google');
    expect(result.requiresAcknowledgment).toBe(false);
  });

  it('returns null instruction for cancellation (notificationType 3)', async () => {
    const bridge = new GoogleBridge({
      packageName: 'com.app',
      serviceAccountKey: '{}',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const msg = makeRTDN({
      subscriptionNotification: {
        version: '1.0',
        notificationType: 3, // CANCELED
        purchaseToken: 'token-abc',
        subscriptionId: 'com.app.pro.monthly',
      },
    });

    const result = await bridge.handleNotification(emptyHeaders, toBody(msg));
    expect(result.notification.type).toBe('cancellation');
    expect(result.instruction).toBeNull();
  });

  it('returns revoke instruction for revocation (notificationType 12)', async () => {
    const bridge = new GoogleBridge({
      packageName: 'com.app',
      serviceAccountKey: '{}',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const msg = makeRTDN({
      subscriptionNotification: {
        version: '1.0',
        notificationType: 12, // REVOKED
        purchaseToken: 'token-abc',
        subscriptionId: 'com.app.pro.monthly',
      },
    });

    const result = await bridge.handleNotification(emptyHeaders, toBody(msg));
    expect(result.notification.type).toBe('revocation');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).reason).toContain('google:revocation');
  });

  it('handles test notification', async () => {
    const bridge = new GoogleBridge({
      packageName: 'com.app',
      serviceAccountKey: '{}',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const msg = JSON.stringify({
      version: '1.0',
      packageName: 'com.app',
      eventTimeMillis: String(Date.now()),
      testNotification: { version: '1.0' },
    });

    const result = await bridge.handleNotification(emptyHeaders, toBody(msg));
    expect(result.notification.type).toBe('test');
    expect(result.instruction).toBeNull();
    expect(result.requiresAcknowledgment).toBe(false);
  });

  it('throws PRODUCT_NOT_MAPPED for unknown subscription ID', async () => {
    const bridge = new GoogleBridge({
      packageName: 'com.app',
      serviceAccountKey: '{}',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const msg = makeRTDN({
      subscriptionNotification: {
        version: '1.0',
        notificationType: 4,
        purchaseToken: 'token-abc',
        subscriptionId: 'unknown.subscription',
      },
    });

    await expect(bridge.handleNotification(emptyHeaders, toBody(msg))).rejects.toMatchObject({ code: 'PRODUCT_NOT_MAPPED' });
  });

  it('throws WALLET_NOT_LINKED when wallet cannot be resolved', async () => {
    const noWalletResolver: WalletResolver = {
      resolveWallet: vi.fn(async () => null),
      linkWallet: vi.fn(async () => {}),
    };

    const bridge = new GoogleBridge({
      packageName: 'com.app',
      serviceAccountKey: '{}',
      productResolver: makeMockResolver(),
      walletResolver: noWalletResolver,
    });

    await expect(bridge.handleNotification(emptyHeaders, toBody(makeRTDN()))).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
  });

  it('throws INVALID_RECEIPT for RTDN without subscription or test notification', async () => {
    const bridge = new GoogleBridge({
      packageName: 'com.app',
      serviceAccountKey: '{}',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const msg = JSON.stringify({
      version: '1.0',
      packageName: 'com.app',
      eventTimeMillis: String(Date.now()),
    });

    await expect(bridge.handleNotification(emptyHeaders, toBody(msg))).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  });
});

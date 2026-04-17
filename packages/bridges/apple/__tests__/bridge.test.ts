import { describe, it, expect, vi } from 'vitest';
import { AppleBridge } from '../src/bridge.js';
import type { StoreProductResolver } from '@drakkar.software/doubloon-storage';
import type { WalletResolver } from '@drakkar.software/doubloon-core';

function makeMockResolver(): StoreProductResolver {
  return {
    resolveProductId: vi.fn(async (store, sku) => {
      if (sku === 'com.app.pro.monthly') return 'a'.repeat(64);
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

describe('AppleBridge', () => {
  it('handles initial purchase notification', async () => {
    const bridge = new AppleBridge({
      bundleId: 'com.app',
      issuerId: 'issuer',
      keyId: 'key',
      privateKey: 'pk',
      environment: 'sandbox',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const body = Buffer.from(JSON.stringify({
      notificationType: 'SUBSCRIBED',
      transactionInfo: {
        transactionId: '123',
        originalTransactionId: '100',
        productId: 'com.app.pro.monthly',
        expiresDate: Date.now() + 30 * 86400000,
        purchaseDate: Date.now(),
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.type).toBe('initial_purchase');
    expect(result.notification.store).toBe('apple');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).source).toBe('apple');
    expect((result.instruction as any).productId).toBe('a'.repeat(64));
  });

  it('returns null instruction for cancellation', async () => {
    const bridge = new AppleBridge({
      bundleId: 'com.app', issuerId: 'i', keyId: 'k', privateKey: 'pk',
      environment: 'sandbox',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const body = Buffer.from(JSON.stringify({
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      subtype: 'AUTO_RENEW_DISABLED',
      transactionInfo: {
        transactionId: '456', originalTransactionId: '100',
        productId: 'com.app.pro.monthly',
        expiresDate: Date.now() + 30 * 86400000,
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.type).toBe('cancellation');
    expect(result.instruction).toBeNull();
  });

  it('returns revoke instruction for refund', async () => {
    const bridge = new AppleBridge({
      bundleId: 'com.app', issuerId: 'i', keyId: 'k', privateKey: 'pk',
      environment: 'sandbox',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const body = Buffer.from(JSON.stringify({
      notificationType: 'REFUND',
      transactionInfo: {
        transactionId: '789', originalTransactionId: '100',
        productId: 'com.app.pro.monthly',
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.type).toBe('refund');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).reason).toContain('apple:refund');
  });

  it('throws PRODUCT_NOT_MAPPED for unknown product', async () => {
    const bridge = new AppleBridge({
      bundleId: 'com.app', issuerId: 'i', keyId: 'k', privateKey: 'pk',
      environment: 'sandbox',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const body = Buffer.from(JSON.stringify({
      notificationType: 'SUBSCRIBED',
      transactionInfo: {
        transactionId: '999', productId: 'unknown.product',
      },
    }));

    await expect(bridge.handleNotification({}, body)).rejects.toMatchObject({ code: 'PRODUCT_NOT_MAPPED' });
  });

  it('throws INVALID_RECEIPT for malformed body', async () => {
    const bridge = new AppleBridge({
      bundleId: 'com.app', issuerId: 'i', keyId: 'k', privateKey: 'pk',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    await expect(bridge.handleNotification({}, Buffer.from('not json'))).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  });

  it('config environment field is optional (deprecated)', async () => {
    // environment is no longer required — derived from signed JWS payload instead
    const bridge = new AppleBridge({
      bundleId: 'com.app', issuerId: 'i', keyId: 'k', privateKey: 'pk',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
      // no environment field
    });

    const body = Buffer.from(JSON.stringify({
      notificationType: 'SUBSCRIBED',
      transactionInfo: {
        transactionId: '222', originalTransactionId: '200',
        productId: 'com.app.pro.monthly',
        expiresDate: Date.now() + 30 * 86400000,
        purchaseDate: Date.now(),
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.environment).toBe('production');
  });

  it('plain JSON non-JWS notifications default to production environment', async () => {
    const bridge = new AppleBridge({
      bundleId: 'com.app', issuerId: 'i', keyId: 'k', privateKey: 'pk',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const body = Buffer.from(JSON.stringify({
      notificationType: 'SUBSCRIBED',
      transactionInfo: {
        transactionId: '333', originalTransactionId: '300',
        productId: 'com.app.pro.monthly',
        expiresDate: Date.now() + 30 * 86400000,
        purchaseDate: Date.now(),
      },
    }));

    const result = await bridge.handleNotification({}, body);
    expect(result.notification.environment).toBe('production');
  });
});

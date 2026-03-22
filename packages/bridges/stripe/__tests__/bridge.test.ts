import { describe, it, expect, vi } from 'vitest';
import { StripeBridge } from '../src/bridge.js';
import type { StoreProductResolver } from '@doubloon/storage';
import type { WalletResolver } from '@doubloon/auth';

function makeMockResolver(): StoreProductResolver {
  return {
    resolveProductId: vi.fn(async (_store, sku) => {
      if (sku === 'price_pro_monthly') return 'c'.repeat(64);
      return null;
    }),
    resolveStoreSku: vi.fn(async () => ['price_pro_monthly']),
  };
}

function makeMockWalletResolver(): WalletResolver {
  return {
    resolveWallet: vi.fn(async () => '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'),
    linkWallet: vi.fn(async () => {}),
  };
}

function makeStripeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_test_123',
    type: 'customer.subscription.created',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: 'sub_abc',
        customer: 'cus_xyz',
        cancel_at_period_end: false,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        metadata: { wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
        items: {
          data: [{ price: { id: 'price_pro_monthly' } }],
        },
      },
    },
    ...overrides,
  } as any;
}

describe('StripeBridge', () => {
  it('handles initial purchase (subscription.created)', async () => {
    const bridge = new StripeBridge({
      webhookSecret: 'whsec_test',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const result = await bridge.handleNotification(makeStripeEvent());
    expect(result.notification.type).toBe('initial_purchase');
    expect(result.notification.store).toBe('stripe');
    expect(result.notification.environment).toBe('sandbox');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).source).toBe('stripe');
    expect((result.instruction as any).productId).toBe('c'.repeat(64));
  });

  it('handles cancellation (subscription.updated with cancel_at_period_end)', async () => {
    const bridge = new StripeBridge({
      webhookSecret: 'whsec_test',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const event = makeStripeEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_abc',
          customer: 'cus_xyz',
          cancel_at_period_end: true,
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          metadata: { wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
          items: { data: [{ price: { id: 'price_pro_monthly' } }] },
        },
        previous_attributes: { cancel_at_period_end: false },
      },
    });

    const result = await bridge.handleNotification(event);
    expect(result.notification.type).toBe('cancellation');
    expect(result.instruction).toBeNull();
  });

  it('handles expiration (subscription.deleted)', async () => {
    const bridge = new StripeBridge({
      webhookSecret: 'whsec_test',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const event = makeStripeEvent({
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_abc',
          customer: 'cus_xyz',
          metadata: { wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
          items: { data: [{ price: { id: 'price_pro_monthly' } }] },
        },
      },
    });

    const result = await bridge.handleNotification(event);
    expect(result.notification.type).toBe('expiration');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).reason).toContain('stripe:expiration');
  });

  it('handles refund (charge.refunded)', async () => {
    const bridge = new StripeBridge({
      webhookSecret: 'whsec_test',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const event = makeStripeEvent({
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_refund_123',
          customer: 'cus_xyz',
          metadata: { wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
          items: { data: [{ price: { id: 'price_pro_monthly' } }] },
        },
      },
    });

    const result = await bridge.handleNotification(event);
    expect(result.notification.type).toBe('refund');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).reason).toContain('stripe:refund');
  });

  it('produces livemode environment for livemode events', async () => {
    const bridge = new StripeBridge({
      webhookSecret: 'whsec_test',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const event = makeStripeEvent({ livemode: true });
    const result = await bridge.handleNotification(event);
    expect(result.notification.environment).toBe('production');
  });

  it('throws WALLET_NOT_LINKED when no wallet found', async () => {
    const noWalletResolver: WalletResolver = {
      resolveWallet: vi.fn(async () => null),
      linkWallet: vi.fn(async () => {}),
    };

    const bridge = new StripeBridge({
      webhookSecret: 'whsec_test',
      productResolver: makeMockResolver(),
      walletResolver: noWalletResolver,
    });

    // No metadata.wallet and walletResolver returns null
    const event = makeStripeEvent({
      data: {
        object: {
          id: 'sub_abc',
          customer: 'cus_xyz',
          metadata: {},
          items: { data: [{ price: { id: 'price_pro_monthly' } }] },
        },
      },
    });

    await expect(bridge.handleNotification(event)).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
  });

  it('returns null instruction when product is not mapped', async () => {
    const bridge = new StripeBridge({
      webhookSecret: 'whsec_test',
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    // Use an unknown price ID
    const event = makeStripeEvent({
      data: {
        object: {
          id: 'sub_abc',
          customer: 'cus_xyz',
          metadata: { wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
          items: { data: [{ price: { id: 'price_unknown' } }] },
        },
      },
    });

    const result = await bridge.handleNotification(event);
    // Stripe bridge logs a warning but doesn't throw; it returns empty productId
    expect(result.notification.productId).toBe('');
    expect(result.instruction).toBeNull();
  });

  it('falls back to walletResolver when no metadata.wallet', async () => {
    const walletResolver = makeMockWalletResolver();
    const bridge = new StripeBridge({
      webhookSecret: 'whsec_test',
      productResolver: makeMockResolver(),
      walletResolver,
    });

    const event = makeStripeEvent({
      data: {
        object: {
          id: 'sub_abc',
          customer: 'cus_xyz',
          metadata: {},
          items: { data: [{ price: { id: 'price_pro_monthly' } }] },
        },
      },
    });

    const result = await bridge.handleNotification(event);
    expect(result.notification.userWallet).toBe('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    expect(walletResolver.resolveWallet).toHaveBeenCalledWith('stripe', 'cus_xyz');
  });
});

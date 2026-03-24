import { describe, it, expect, vi } from 'vitest';
import Stripe from 'stripe';
import { StripeBridge } from '../src/bridge.js';
import type { StoreProductResolver } from '@doubloon/storage';
import type { WalletResolver } from '@doubloon/auth';

const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests';

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

function toBody(event: unknown): Buffer {
  return Buffer.from(JSON.stringify(event), 'utf-8');
}

/** Create a signed Stripe request (body + headers with valid signature). */
function signedRequest(event: unknown): { headers: Record<string, string>; body: Buffer } {
  const body = toBody(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body.toString('utf-8'),
    secret: TEST_WEBHOOK_SECRET,
  });
  return { headers: { 'stripe-signature': signature }, body };
}

/** Helper to call handleNotification with a properly signed event. */
async function callWithSignedEvent(bridge: StripeBridge, event: unknown) {
  const { headers, body } = signedRequest(event);
  return bridge.handleNotification(headers, body);
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
      webhookSecret: TEST_WEBHOOK_SECRET,
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const result = await callWithSignedEvent(bridge, makeStripeEvent());
    expect(result.notification.type).toBe('initial_purchase');
    expect(result.notification.store).toBe('stripe');
    expect(result.notification.environment).toBe('sandbox');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).source).toBe('stripe');
    expect((result.instruction as any).productId).toBe('c'.repeat(64));
  });

  it('handles cancellation (subscription.updated with cancel_at_period_end)', async () => {
    const bridge = new StripeBridge({
      webhookSecret: TEST_WEBHOOK_SECRET,
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

    const result = await callWithSignedEvent(bridge, event);
    expect(result.notification.type).toBe('cancellation');
    expect(result.instruction).toBeNull();
  });

  it('handles expiration (subscription.deleted)', async () => {
    const bridge = new StripeBridge({
      webhookSecret: TEST_WEBHOOK_SECRET,
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

    const result = await callWithSignedEvent(bridge, event);
    expect(result.notification.type).toBe('expiration');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).reason).toContain('stripe:expiration');
  });

  it('handles refund (charge.refunded)', async () => {
    const bridge = new StripeBridge({
      webhookSecret: TEST_WEBHOOK_SECRET,
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

    const result = await callWithSignedEvent(bridge, event);
    expect(result.notification.type).toBe('refund');
    expect(result.instruction).not.toBeNull();
    expect((result.instruction as any).reason).toContain('stripe:refund');
  });

  it('produces livemode environment for livemode events', async () => {
    const bridge = new StripeBridge({
      webhookSecret: TEST_WEBHOOK_SECRET,
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    const event = makeStripeEvent({ livemode: true });
    const result = await callWithSignedEvent(bridge, event);
    expect(result.notification.environment).toBe('production');
  });

  it('throws WALLET_NOT_LINKED when no wallet found', async () => {
    const noWalletResolver: WalletResolver = {
      resolveWallet: vi.fn(async () => null),
      linkWallet: vi.fn(async () => {}),
    };

    const bridge = new StripeBridge({
      webhookSecret: TEST_WEBHOOK_SECRET,
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

    await expect(callWithSignedEvent(bridge, event)).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
  });

  it('returns null instruction when product is not mapped', async () => {
    const bridge = new StripeBridge({
      webhookSecret: TEST_WEBHOOK_SECRET,
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

    await expect(callWithSignedEvent(bridge, event)).rejects.toMatchObject({
      code: 'PRODUCT_NOT_MAPPED',
    });
  });

  it('rejects requests without stripe-signature header', async () => {
    const bridge = new StripeBridge({
      webhookSecret: TEST_WEBHOOK_SECRET,
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    await expect(
      bridge.handleNotification({}, toBody(makeStripeEvent())),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('rejects requests with invalid stripe-signature', async () => {
    const bridge = new StripeBridge({
      webhookSecret: TEST_WEBHOOK_SECRET,
      productResolver: makeMockResolver(),
      walletResolver: makeMockWalletResolver(),
    });

    await expect(
      bridge.handleNotification({ 'stripe-signature': 'bad_sig' }, toBody(makeStripeEvent())),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('falls back to walletResolver when no metadata.wallet', async () => {
    const walletResolver = makeMockWalletResolver();
    const bridge = new StripeBridge({
      webhookSecret: TEST_WEBHOOK_SECRET,
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

    const result = await callWithSignedEvent(bridge, event);
    expect(result.notification.userWallet).toBe('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    expect(walletResolver.resolveWallet).toHaveBeenCalledWith('stripe', 'cus_xyz');
  });
});

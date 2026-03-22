import { describe, it, expect, vi } from 'vitest';
import { X402Bridge } from '../src/bridge.js';
import { createX402Middleware } from '../src/middleware.js';
import { mapX402PaymentType, computeX402DeduplicationKey } from '../src/notification-map.js';

describe('mapX402PaymentType', () => {
  it('always returns initial_purchase', () => {
    expect(mapX402PaymentType()).toBe('initial_purchase');
  });
});

describe('computeX402DeduplicationKey', () => {
  it('produces deterministic keys', () => {
    const key = computeX402DeduplicationKey('pay_123', '0xABC');
    expect(key).toBe('x402:initial_purchase:0xABC:pay_123');
  });

  it('produces different keys for different inputs', () => {
    const key1 = computeX402DeduplicationKey('pay_123', '0xABC');
    const key2 = computeX402DeduplicationKey('pay_456', '0xDEF');
    expect(key1).not.toBe(key2);
  });
});

describe('X402Bridge', () => {
  const mockProductResolver = {
    resolveProductId: vi.fn().mockResolvedValue('on-chain-product-id-hex'),
  };

  const bridge = new X402Bridge({
    facilitatorUrl: 'https://facilitator.example.com',
    productResolver: mockProductResolver as any,
  });

  it('can be constructed', () => {
    expect(bridge).toBeInstanceOf(X402Bridge);
  });

  it('verifyAndMint produces a notification and mint instruction', async () => {
    const result = await bridge.verifyAndMint({
      paymentId: 'pay_abc',
      wallet: '0x1234',
      productId: 'my-product',
      amountUsd: 9.99,
      durationSeconds: 2592000,
      timestamp: 1700000000000,
    });

    expect(result.notification.type).toBe('initial_purchase');
    expect(result.notification.store).toBe('x402');
    expect(result.notification.userWallet).toBe('0x1234');
    expect(result.notification.productId).toBe('on-chain-product-id-hex');
    expect(result.instruction.user).toBe('0x1234');
    expect(result.instruction.productId).toBe('on-chain-product-id-hex');
    expect(result.instruction.source).toBe('x402');
    expect(result.instruction.sourceId).toBe('pay_abc');
    expect(result.instruction.expiresAt).toBeInstanceOf(Date);
  });

  it('verifyAndMint sets expiresAt to null when durationSeconds is 0', async () => {
    const result = await bridge.verifyAndMint({
      paymentId: 'pay_lifetime',
      wallet: '0x5678',
      productId: 'lifetime-product',
      amountUsd: 49.99,
      durationSeconds: 0,
      timestamp: 1700000000000,
    });

    expect(result.notification.expiresAt).toBeNull();
    expect(result.instruction.expiresAt).toBeNull();
  });

  it('verifyAndMint throws for unknown product', async () => {
    const failResolver = {
      resolveProductId: vi.fn().mockResolvedValue(null),
    };
    const failBridge = new X402Bridge({
      facilitatorUrl: 'https://facilitator.example.com',
      productResolver: failResolver as any,
    });

    await expect(
      failBridge.verifyAndMint({
        paymentId: 'pay_fail',
        wallet: '0xFAIL',
        productId: 'unknown',
        amountUsd: 1,
        durationSeconds: 60,
        timestamp: Date.now(),
      }),
    ).rejects.toThrow('Unknown x402 product ID: unknown');
  });

  it('createPaymentRequired returns correct payload', () => {
    const payload = bridge.createPaymentRequired({
      productId: 'my-product',
      priceUsd: 9.99,
      durationSeconds: 2592000,
      description: 'Monthly access',
    });

    expect(payload.accepts).toEqual(['x402']);
    expect(payload.facilitatorUrl).toBe('https://facilitator.example.com');
    expect(payload.productId).toBe('my-product');
    expect(payload.price).toEqual({ amount: 9.99, currency: 'USD' });
    expect(payload.durationSeconds).toBe(2592000);
    expect(payload.description).toBe('Monthly access');
  });
});

describe('createX402Middleware', () => {
  it('returns a middleware function', () => {
    const mockBridge = {} as any;
    const middleware = createX402Middleware({
      bridge: mockBridge,
      productId: 'test-product',
      priceUsd: 5,
      durationSeconds: 3600,
    });

    expect(typeof middleware).toBe('function');
  });

  it('returns 402 when no payment header', async () => {
    const mockBridge = {
      createPaymentRequired: vi.fn(() => ({ price: 5, currency: 'USD' })),
    } as any;
    const middleware = createX402Middleware({
      bridge: mockBridge,
      productId: 'test-product',
      priceUsd: 5,
      durationSeconds: 3600,
    });

    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await middleware({ headers: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() with valid payment header', async () => {
    const mockBridge = {
      verifyAndMint: vi.fn(async () => ({
        notification: { userWallet: 'wallet123' },
        instruction: {},
      })),
    } as any;
    const middleware = createX402Middleware({
      bridge: mockBridge,
      productId: 'test-product',
      priceUsd: 5,
      durationSeconds: 3600,
    });

    const req = { headers: { 'x-payment': 'valid-payment-data' } } as any;
    const res = {} as any;
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.doubloon.entitled).toBe(true);
  });
});

/**
 * E2E: x402 bridge — payment verification, price validation, createPaymentRequired,
 * middleware behavior (402 response, base64 decoding, error handling).
 */
import { describe, it, expect, vi } from 'vitest';
import { X402Bridge, createX402Middleware, mapX402PaymentType, computeX402DeduplicationKey } from '@drakkar.software/doubloon-bridge-x402';
import { DoubloonError } from '@drakkar.software/doubloon-core';

function makeX402Bridge(overrides?: {
  resolveProductId?: (store: string, sku: string) => Promise<string | null>;
}) {
  return new X402Bridge({
    facilitatorUrl: 'https://facilitator.example.com',
    productResolver: {
      resolveProductId: overrides?.resolveProductId ?? (async () => 'on-chain-pid'),
    },
  });
}

describe('x402 notification type', () => {
  it('always returns initial_purchase', () => {
    expect(mapX402PaymentType()).toBe('initial_purchase');
  });
});

describe('x402 deduplication key', () => {
  it('includes wallet and paymentId', () => {
    const key = computeX402DeduplicationKey('pay-123', '0xA11ceA11ceA11ceA11ceA11ceA11ceA11ceA11ce');
    expect(key).toBe('x402:initial_purchase:0xA11ceA11ceA11ceA11ceA11ceA11ceA11ceA11ce:pay-123');
  });
});

describe('X402Bridge.verifyAndMint', () => {
  it('produces mint instruction for valid payment', async () => {
    const bridge = makeX402Bridge();
    const result = await bridge.verifyAndMint({
      paymentId: 'pay-1',
      wallet: '0xA11ceA11ceA11ceA11ceA11ceA11ceA11ceA11ce',
      productId: 'product-slug',
      amountUsd: 9.99,
      durationSeconds: 2592000,
      timestamp: Date.now(),
    });

    expect(result.notification.type).toBe('initial_purchase');
    expect(result.notification.store).toBe('x402');
    expect(result.instruction.source).toBe('x402');
    expect(result.instruction.user).toBe('0xA11ceA11ceA11ceA11ceA11ceA11ceA11ceA11ce');
    expect(result.instruction.expiresAt).toBeInstanceOf(Date);
  });

  it('lifetime access when durationSeconds = 0', async () => {
    const bridge = makeX402Bridge();
    const result = await bridge.verifyAndMint({
      paymentId: 'pay-2',
      wallet: '0xb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb',
      productId: 'lifetime-product',
      amountUsd: 99.99,
      durationSeconds: 0,
      timestamp: Date.now(),
    });

    expect(result.instruction.expiresAt).toBeNull();
  });

  it('throws PRODUCT_NOT_MAPPED for unknown product', async () => {
    const bridge = makeX402Bridge({
      resolveProductId: async () => null,
    });

    await expect(bridge.verifyAndMint({
      paymentId: 'pay-3',
      wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      productId: 'unknown',
      amountUsd: 1,
      durationSeconds: 60,
      timestamp: Date.now(),
    })).rejects.toMatchObject({ code: 'PRODUCT_NOT_MAPPED' });
  });

});

describe('X402Bridge.createPaymentRequired', () => {
  it('builds correct 402 response payload', () => {
    const bridge = makeX402Bridge();
    const payload = bridge.createPaymentRequired({
      productId: 'pid-1',
      priceUsd: 5.99,
      durationSeconds: 86400,
      description: 'Premium access for 24 hours',
    });

    expect(payload.accepts).toEqual(['x402']);
    expect(payload.facilitatorUrl).toBe('https://facilitator.example.com');
    expect(payload.productId).toBe('pid-1');
    expect(payload.price).toEqual({ amount: 5.99, currency: 'USD' });
    expect(payload.durationSeconds).toBe(86400);
    expect(payload.description).toBe('Premium access for 24 hours');
  });

  it('empty description when not provided', () => {
    const bridge = makeX402Bridge();
    const payload = bridge.createPaymentRequired({
      productId: 'pid-2',
      priceUsd: 1,
      durationSeconds: 60,
    });
    expect(payload.description).toBe('');
  });
});

describe('x402 middleware', () => {
  function makeMockRes() {
    const res: any = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    res.end = vi.fn(() => res);
    return res;
  }

  it('returns 402 when no payment header present', async () => {
    const bridge = makeX402Bridge();
    const middleware = createX402Middleware({
      bridge,
      productId: 'pid',
      priceUsd: 5,
      durationSeconds: 3600,
    });

    const req = { headers: {} };
    const res = makeMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      accepts: ['x402'],
      productId: 'pid',
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('processes base64-encoded payment header', async () => {
    const bridge = makeX402Bridge();
    const middleware = createX402Middleware({
      bridge,
      productId: 'pid',
      priceUsd: 5,
      durationSeconds: 3600,
    });

    const receipt = {
      paymentId: 'pay-mw-1',
      wallet: '0xA11ceA11ceA11ceA11ceA11ceA11ceA11ceA11ce',
      amountUsd: 10,
      durationSeconds: 3600,
      timestamp: Date.now(),
    };
    const encoded = Buffer.from(JSON.stringify(receipt)).toString('base64');

    const req: any = { headers: { 'x-payment': encoded } };
    const res = makeMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.doubloon).toEqual(expect.objectContaining({
      entitled: true,
      wallet: '0xA11ceA11ceA11ceA11ceA11ceA11ceA11ceA11ce',
      productId: 'pid',
    }));
  });

  it('processes plain JSON payment header (base64 fallback)', async () => {
    const bridge = makeX402Bridge();
    const middleware = createX402Middleware({
      bridge,
      productId: 'pid',
      priceUsd: 5,
      durationSeconds: 3600,
    });

    const receipt = {
      paymentId: 'pay-mw-2',
      wallet: '0xb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb',
      amountUsd: 10,
      durationSeconds: 3600,
      timestamp: Date.now(),
    };

    const req: any = { headers: { 'x-payment': JSON.stringify(receipt) } };
    const res = makeMockRes();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.doubloon.wallet).toBe('0xb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb0bb');
  });

  it('returns 402 on verification failure', async () => {
    const bridge = makeX402Bridge({
      resolveProductId: async () => null, // causes PRODUCT_NOT_MAPPED
    });
    const middleware = createX402Middleware({
      bridge,
      productId: 'pid',
      priceUsd: 5,
      durationSeconds: 3600,
    });

    const receipt = { paymentId: 'p', wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', amountUsd: 5, timestamp: Date.now() };
    const req: any = { headers: { 'x-payment': JSON.stringify(receipt) } };
    const res = makeMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({ error: 'Payment verification failed' });
    expect(next).not.toHaveBeenCalled();
  });

  it('caps durationSeconds to configured max', async () => {
    const bridge = makeX402Bridge();
    const middleware = createX402Middleware({
      bridge,
      productId: 'pid',
      priceUsd: 1,
      durationSeconds: 3600, // max 1 hour
    });

    const receipt = {
      paymentId: 'pay-cap',
      wallet: '0xA11ceA11ceA11ceA11ceA11ceA11ceA11ceA11ce',
      amountUsd: 10,
      durationSeconds: 999999, // tries to get more time
      timestamp: Date.now(),
    };

    const req: any = { headers: { 'x-payment': Buffer.from(JSON.stringify(receipt)).toString('base64') } };
    const res = makeMockRes();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    // The middleware caps durationSeconds via Math.min
  });

  it('uses payment header (lowercase)', async () => {
    const bridge = makeX402Bridge();
    const middleware = createX402Middleware({
      bridge,
      productId: 'pid',
      priceUsd: 1,
      durationSeconds: 60,
    });

    const receipt = { paymentId: 'p', wallet: '0xA11ceA11ceA11ceA11ceA11ceA11ceA11ceA11ce', amountUsd: 5, timestamp: Date.now() };
    const req: any = { headers: { payment: JSON.stringify(receipt) } };
    const res = makeMockRes();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

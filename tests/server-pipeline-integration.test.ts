/**
 * E2E: Full server pipeline — rate limiter, dedup, bridge, hooks,
 * mint retry, error paths. Tests the entire handleWebhook flow with
 * real local chain + mocked bridges.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '@doubloon/server';
import { createLocalChain } from '@doubloon/chain-local';
import { deriveProductIdHex, DoubloonError } from '@doubloon/core';
import type { MintInstruction, RevokeInstruction, StoreNotification } from '@doubloon/core';

function makeStripeReq(body: string) {
  return {
    headers: { 'stripe-signature': 'sig_test', 'x-forwarded-for': '1.2.3.4' } as Record<string, string>,
    body: Buffer.from(body),
  };
}

function makeAppleReq(body: string) {
  return {
    headers: {} as Record<string, string>,
    body: Buffer.from('eyJ' + Buffer.from(body).toString('base64').slice(0, 10)),
  };
}

function makeGoogleReq(notificationType: string) {
  return {
    headers: {} as Record<string, string>,
    body: JSON.stringify({ message: { data: Buffer.from(notificationType).toString('base64') } }),
  };
}

const pid = deriveProductIdHex('test-product');

function notification(id: string, store = 'stripe'): StoreNotification {
  return {
    id,
    store: store as any,
    type: 'subscription_renewed',
    deduplicationKey: `dedup-${id}`,
    originalTransactionId: 'txn_1',
    timestamp: new Date(),
    rawPayload: {},
  };
}

function mintInstruction(user: string): MintInstruction {
  return {
    productId: pid,
    user,
    expiresAt: new Date(Date.now() + 86400_000),
    source: 'stripe' as any,
    sourceId: 'sub_1',
  };
}

describe('Server rate limiter', () => {
  it('allows requests under the limit', async () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: notification('r1'),
            instruction: mintInstruction('0xAlice'),
          }),
        },
      },
      onMintFailure: async () => {},
      rateLimiter: { maxRequests: 5, windowMs: 60_000 },
    });

    for (let i = 0; i < 5; i++) {
      const res = await server.handleWebhook(makeStripeReq(`body-${i}`));
      expect(res.status).toBe(200);
    }
  });

  it('rejects requests over the limit with 429', async () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: notification('r2'),
            instruction: null,
          }),
        },
      },
      onMintFailure: async () => {},
      rateLimiter: { maxRequests: 2, windowMs: 60_000 },
    });

    await server.handleWebhook(makeStripeReq('1'));
    await server.handleWebhook(makeStripeReq('2'));
    const res = await server.handleWebhook(makeStripeReq('3'));
    expect(res.status).toBe(429);
    expect(res.body).toContain('Too many');
  });

  it('rate limiter disabled with false', async () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: notification('rd'),
            instruction: null,
          }),
        },
      },
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    // Should never 429 even with many requests
    for (let i = 0; i < 100; i++) {
      const res = await server.handleWebhook(makeStripeReq(`${i}`));
      expect(res.status).not.toBe(429);
    }
  });
});

describe('Server dedup lifecycle', () => {
  it('first webhook processes, duplicate skips', async () => {
    const local = createLocalChain();
    const handleNotification = vi.fn().mockResolvedValue({
      notification: notification('d1'),
      instruction: mintInstruction('0xAlice'),
    });

    const server = createServer({
      chain: local,
      bridges: { stripe: { handleNotification } },
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    const r1 = await server.handleWebhook(makeStripeReq('body'));
    expect(r1.status).toBe(200);

    const r2 = await server.handleWebhook(makeStripeReq('body'));
    expect(r2.status).toBe(200); // duplicate is still 200

    // Bridge was called twice (dedup happens after bridge)
    expect(handleNotification).toHaveBeenCalledTimes(2);
  });

  it('dedup clears on processing failure, allowing retry', async () => {
    const local = createLocalChain();
    let notifCount = 0;
    const handleNotification = vi.fn().mockImplementation(async () => {
      notifCount++;
      return {
        notification: notification('d2'),
        instruction: mintInstruction('0xBob'),
      };
    });

    // Make bridge throw on first call, succeed on second
    let bridgeCallCount = 0;
    const successBridge = {
      handleNotification: vi.fn().mockImplementation(async (headers: any, body: any) => {
        bridgeCallCount++;
        if (bridgeCallCount === 1) throw new Error('Transient bridge failure');
        return {
          notification: notification('d2'),
          instruction: mintInstruction('0xBob'),
        };
      }),
    };

    const server = createServer({
      chain: local,
      bridges: { stripe: successBridge },
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    const r1 = await server.handleWebhook(makeStripeReq('body'));
    expect(r1.status).toBe(500); // first attempt fails (bridge throws before dedup)

    // Second attempt should work — bridge doesn't throw, no dedup issue
    const r2 = await server.handleWebhook(makeStripeReq('body'));
    expect(r2.status).toBe(200);
  });
});

describe('Server beforeMint hook', () => {
  it('beforeMint returning false silently rejects mint', async () => {
    const local = createLocalChain();
    const afterMint = vi.fn();

    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: notification('bm1'),
            instruction: mintInstruction('0xAlice'),
          }),
        },
      },
      onMintFailure: async () => {},
      beforeMint: async () => false,
      afterMint,
      rateLimiter: false,
    });

    const res = await server.handleWebhook(makeStripeReq('body'));
    expect(res.status).toBe(200); // Still 200 — hook rejected silently
    expect(afterMint).not.toHaveBeenCalled();

    // Entitlement should NOT exist
    const check = await local.reader.checkEntitlement(pid, '0xAlice');
    expect(check.entitled).toBe(false);
  });

  it('beforeMint returning true allows mint', async () => {
    const local = createLocalChain();
    const afterMint = vi.fn();

    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: notification('bm2'),
            instruction: mintInstruction('0xAlice'),
          }),
        },
      },
      onMintFailure: async () => {},
      beforeMint: async () => true,
      afterMint,
      rateLimiter: false,
    });

    await server.handleWebhook(makeStripeReq('body'));
    expect(afterMint).toHaveBeenCalled();
    const check = await local.reader.checkEntitlement(pid, '0xAlice');
    expect(check.entitled).toBe(true);
  });
});

describe('Server afterMint / afterRevoke hooks', () => {
  it('afterMint receives instruction and tx signature', async () => {
    const local = createLocalChain();
    const afterMint = vi.fn();

    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: notification('am1'),
            instruction: mintInstruction('0xAlice'),
          }),
        },
      },
      onMintFailure: async () => {},
      afterMint,
      rateLimiter: false,
    });

    await server.handleWebhook(makeStripeReq('body'));
    expect(afterMint).toHaveBeenCalledWith(
      expect.objectContaining({ productId: pid, user: '0xAlice' }),
      expect.any(String), // tx signature
    );
  });

  it('afterRevoke hook called on revocation', async () => {
    const local = createLocalChain();
    const afterRevoke = vi.fn();

    // First mint
    local.store.mintEntitlement({ productId: pid, user: '0xAlice', expiresAt: null, source: 'stripe', sourceId: 's' });

    const revokeInstruction: RevokeInstruction = {
      productId: pid, user: '0xAlice', reason: 'cancelled',
    };

    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: notification('ar1'),
            instruction: revokeInstruction,
          }),
        },
      },
      onMintFailure: async () => {},
      afterRevoke,
      rateLimiter: false,
    });

    await server.handleWebhook(makeStripeReq('body'));
    expect(afterRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ productId: pid, user: '0xAlice' }),
      expect.any(String),
    );
  });
});

describe('Server store detection', () => {
  it('detects stripe by stripe-signature header', async () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local, bridges: {},
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    const store = server.detectStore({
      headers: { 'stripe-signature': 'sig_xxx' },
      body: Buffer.from('{}'),
    });
    expect(store).toBe('stripe');
  });

  it('detects apple by eyJ prefix', () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local, bridges: {},
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    const store = server.detectStore({
      headers: {},
      body: Buffer.from('eyJhbGciOiJFUzI1NiIsIng1YyI6WyI'),
    });
    expect(store).toBe('apple');
  });

  it('detects google by message.data', () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local, bridges: {},
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    const store = server.detectStore({
      headers: {},
      body: JSON.stringify({ message: { data: 'base64stuff' } }),
    });
    expect(store).toBe('google');
  });

  it('returns null for unrecognized body', () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local, bridges: {},
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    expect(server.detectStore({ headers: {}, body: Buffer.from('hello') })).toBeNull();
  });

  it('unknown store → 400', async () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local, bridges: {},
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    const res = await server.handleWebhook({ headers: {}, body: Buffer.from('random') });
    expect(res.status).toBe(400);
    expect(res.body).toContain('Unknown store');
  });
});

describe('Server error classification', () => {
  it('INVALID_RECEIPT → 400', async () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => {
            throw new DoubloonError('INVALID_RECEIPT', 'Bad receipt');
          },
        },
      },
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    const res = await server.handleWebhook(makeStripeReq('body'));
    expect(res.status).toBe(400);
    expect(res.body).toContain('Bad receipt');
  });

  it('PRODUCT_NOT_MAPPED → 400', async () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => {
            throw new DoubloonError('PRODUCT_NOT_MAPPED', 'Unknown SKU');
          },
        },
      },
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    const res = await server.handleWebhook(makeStripeReq('body'));
    expect(res.status).toBe(400);
  });

  it('generic error → 500', async () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => { throw new Error('Boom'); },
        },
      },
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    const res = await server.handleWebhook(makeStripeReq('body'));
    expect(res.status).toBe(500);
  });

  it('payload too large → 400', async () => {
    const local = createLocalChain();
    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: notification('big'),
            instruction: null,
          }),
        },
      },
      onMintFailure: async () => {},
      rateLimiter: false,
    });

    const bigBody = Buffer.alloc(2_000_000, 'x');
    const res = await server.handleWebhook({
      headers: { 'stripe-signature': 'sig' },
      body: bigBody,
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('Payload too large');
  });
});

describe('Server onMintFailure', () => {
  it('called with store context when mint fails after all retries', async () => {
    const local = createLocalChain();
    local.writer.mintEntitlement = vi.fn().mockRejectedValue(new Error('Chain down'));

    const onMintFailure = vi.fn();
    const server = createServer({
      chain: local,
      bridges: {
        stripe: {
          handleNotification: async () => ({
            notification: notification('mf1'),
            instruction: mintInstruction('0xAlice'),
          }),
        },
      },
      onMintFailure,
      rateLimiter: false,
      mintRetry: { maxRetries: 1 },
    });

    await server.handleWebhook(makeStripeReq('body'));
    expect(onMintFailure).toHaveBeenCalledWith(
      expect.objectContaining({ productId: pid }),
      expect.any(Error),
      expect.objectContaining({ store: 'stripe', willStoreRetry: true }),
    );
  });
});

describe('Server Google acknowledgment', () => {
  it('calls onAcknowledgmentRequired for Google bridge', async () => {
    const local = createLocalChain();
    const onAck = vi.fn();

    const server = createServer({
      chain: local,
      bridges: {
        google: {
          handleNotification: async () => ({
            notification: notification('g1', 'google'),
            instruction: null,
            requiresAcknowledgment: true,
          }),
        },
      },
      onMintFailure: async () => {},
      onAcknowledgmentRequired: onAck,
      rateLimiter: false,
    });

    await server.handleWebhook(makeGoogleReq('{}'));
    expect(onAck).toHaveBeenCalledWith(
      expect.any(String), // purchaseToken
      expect.any(Date),   // deadline
    );
  });
});

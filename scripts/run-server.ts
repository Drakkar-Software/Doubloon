#!/usr/bin/env npx tsx
/**
 * Doubloon local development server.
 *
 * Starts an HTTP server backed by the in-memory local chain.
 * Registers sample products, then listens for webhook requests
 * and entitlement check queries.
 *
 * Usage:
 *   npx tsx scripts/run-server.ts
 *   # or
 *   pnpm run dev
 *
 * Endpoints:
 *   POST /webhook          — Receive store webhooks (Stripe, Apple, Google)
 *   GET  /check/:product/:wallet — Check entitlement
 *   GET  /products          — List registered products
 *   GET  /entitlements/:wallet — List all entitlements for a wallet
 *   GET  /health            — Health check
 */
import http from 'node:http';
import { createLocalChain } from '@doubloon/chain-local';
import { createServer as createDoubloonServer } from '@doubloon/server';
import { deriveProductIdHex } from '@doubloon/core';
import type { Logger, MintInstruction, StoreNotification } from '@doubloon/core';

const PORT = parseInt(process.env.PORT ?? '3210', 10);

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger: Logger = {
  debug: (msg, ctx) => console.log(`  [DEBUG] ${msg}`, ctx ?? ''),
  info: (msg, ctx) => console.log(`  [INFO]  ${msg}`, ctx ?? ''),
  warn: (msg, ctx) => console.warn(`  [WARN]  ${msg}`, ctx ?? ''),
  error: (msg, ctx) => console.error(`  [ERROR] ${msg}`, ctx ?? ''),
};

// ---------------------------------------------------------------------------
// Local chain + sample products
// ---------------------------------------------------------------------------
const local = createLocalChain({ logger });

const PRODUCTS = {
  'pro-monthly': { name: 'Pro Monthly', duration: 30 * 86400 },
  'pro-yearly': { name: 'Pro Yearly', duration: 365 * 86400 },
  'lifetime': { name: 'Lifetime Access', duration: 0 },
} as const;

const productIds: Record<string, string> = {};

for (const [slug, meta] of Object.entries(PRODUCTS)) {
  const id = deriveProductIdHex(slug);
  productIds[slug] = id;
  local.writer.registerProduct({
    productId: id,
    name: meta.name,
    metadataUri: `https://example.com/products/${slug}.json`,
    defaultDuration: meta.duration,
    signer: local.signer.publicKey,
  });
}

console.log('\nRegistered products:');
for (const [slug, id] of Object.entries(productIds)) {
  console.log(`  ${slug} -> ${id.slice(0, 16)}...`);
}

// ---------------------------------------------------------------------------
// Mock bridges (accept any payload, extract fields from JSON body)
// ---------------------------------------------------------------------------
function createMockBridge(store: 'stripe' | 'apple' | 'google') {
  return {
    async handleNotification(headers: Record<string, string>, body: Buffer) {
      const parsed = JSON.parse(body.toString('utf-8'));

      const productSlug = parsed.productSlug ?? 'pro-monthly';
      const productId = productIds[productSlug] ?? deriveProductIdHex(productSlug);
      const wallet = parsed.wallet ?? parsed.userWallet ?? '0xDefaultWallet';
      const type = parsed.type ?? 'initial_purchase';
      const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;

      const notification: StoreNotification = {
        id: parsed.id ?? `${store}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type,
        store,
        environment: parsed.environment ?? 'production',
        productId,
        userWallet: wallet,
        originalTransactionId: parsed.transactionId ?? `txn_${Date.now()}`,
        expiresAt,
        autoRenew: parsed.autoRenew ?? true,
        storeTimestamp: new Date(),
        receivedTimestamp: new Date(),
        deduplicationKey: parsed.deduplicationKey ?? `${store}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        raw: parsed,
      };

      let instruction: MintInstruction | { productId: string; user: string; reason: string } | null = null;

      if (['initial_purchase', 'renewal', 'billing_recovery', 'uncancellation'].includes(type)) {
        instruction = {
          productId,
          user: wallet,
          expiresAt,
          source: store,
          sourceId: notification.originalTransactionId,
        };
      } else if (['revocation', 'refund', 'expiration'].includes(type)) {
        instruction = {
          productId,
          user: wallet,
          reason: `${store}:${type}`,
        };
      }

      return { notification, instruction };
    },
  };
}

// ---------------------------------------------------------------------------
// Doubloon server
// ---------------------------------------------------------------------------
const doubloon = createDoubloonServer({
  chain: {
    reader: local.reader,
    writer: local.writer,
    signer: local.signer,
  },
  bridges: {
    stripe: createMockBridge('stripe'),
    apple: createMockBridge('apple'),
    google: createMockBridge('google'),
  },
  rateLimiter: { maxRequests: 120, windowMs: 60_000 },
  beforeMint: async (instruction: MintInstruction, notification: StoreNotification) => {
    logger.info(`beforeMint: ${notification.store} -> ${instruction.user} for product ${instruction.productId.slice(0, 8)}...`);
    return true;
  },
  afterMint: async (instruction, txSig) => {
    logger.info(`afterMint: tx=${txSig} for user=${instruction.user}`);
  },
  afterRevoke: async (instruction, txSig) => {
    logger.info(`afterRevoke: tx=${txSig} for user=${instruction.user}`);
  },
  onMintFailure: async (instruction, error, ctx) => {
    logger.error(`Mint failed: ${error.message}`, {
      store: ctx.store,
      retryCount: ctx.retryCount,
      user: instruction.user,
    });
  },
  logger,
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const method = req.method ?? 'GET';

  try {
    // POST /webhook
    if (method === 'POST' && url.pathname === '/webhook') {
      const body = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      const result = await doubloon.handleWebhook({ headers, body });
      jsonResponse(res, result.status, { status: result.status, body: result.body });
      return;
    }

    // GET /check/:product/:wallet
    const checkMatch = url.pathname.match(/^\/check\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && checkMatch) {
      const [, productSlug, wallet] = checkMatch;
      const pid = productIds[productSlug] ?? productSlug;
      const check = await doubloon.checkEntitlement(pid, wallet);
      jsonResponse(res, 200, check);
      return;
    }

    // GET /products
    if (method === 'GET' && url.pathname === '/products') {
      const products = local.store.getAllProducts();
      jsonResponse(res, 200, { products, slugMap: productIds });
      return;
    }

    // GET /entitlements/:wallet
    const entMatch = url.pathname.match(/^\/entitlements\/([^/]+)$/);
    if (method === 'GET' && entMatch) {
      const [, wallet] = entMatch;
      const entitlements = local.store.getUserEntitlements(wallet);
      jsonResponse(res, 200, { wallet, entitlements });
      return;
    }

    // GET /health
    if (method === 'GET' && url.pathname === '/health') {
      jsonResponse(res, 200, {
        status: 'ok',
        products: local.store.productCount,
        entitlements: local.store.entitlementCount,
      });
      return;
    }

    jsonResponse(res, 404, { error: 'Not found' });
  } catch (err) {
    logger.error('Request error', { url: url.pathname, error: err });
    jsonResponse(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\nDoubloon dev server running on http://localhost:${PORT}`);
  console.log('\nEndpoints:');
  console.log(`  POST http://localhost:${PORT}/webhook`);
  console.log(`  GET  http://localhost:${PORT}/check/{productSlug}/{wallet}`);
  console.log(`  GET  http://localhost:${PORT}/products`);
  console.log(`  GET  http://localhost:${PORT}/entitlements/{wallet}`);
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log('');
});

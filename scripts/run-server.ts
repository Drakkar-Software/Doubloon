#!/usr/bin/env npx tsx
/**
 * Doubloon local development server.
 *
 * Starts an HTTP server using a Starfish destination.
 * Set STARFISH_URL and STARFISH_SIGNER_KEY environment variables.
 *
 * Usage:
 *   STARFISH_URL=http://localhost:3000 STARFISH_SIGNER_KEY=dev-key pnpm run dev
 *
 * Endpoints:
 *   POST /webhook              — Receive store webhooks
 *   GET  /check/:product/:user — Check entitlement
 *   GET  /health               — Health check
 */
import http from 'node:http';
import { createServer as createDoubloonServer } from '@drakkar.software/doubloon-server';
import { createStarfishDestination } from '@drakkar.software/doubloon-starfish';
import { StarfishClient } from '@drakkar.software/starfish-client';
import { deriveProductIdHex } from '@drakkar.software/doubloon-core';
import type { Logger, MintInstruction, StoreNotification } from '@drakkar.software/doubloon-core';

const PORT = parseInt(process.env.PORT ?? '3210', 10);
const STARFISH_URL = process.env.STARFISH_URL ?? 'http://localhost:3000';
const STARFISH_SIGNER_KEY = process.env.STARFISH_SIGNER_KEY ?? 'dev-key';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger: Logger = {
  debug: (msg, ctx) => console.log(`  [DEBUG] ${msg}`, ctx ?? ''),
  info:  (msg, ctx) => console.log(`  [INFO]  ${msg}`, ctx ?? ''),
  warn:  (msg, ctx) => console.warn(`  [WARN]  ${msg}`, ctx ?? ''),
  error: (msg, ctx) => console.error(`  [ERROR] ${msg}`, ctx ?? ''),
};

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
const PRODUCTS = [
  { slug: 'pro-monthly', name: 'Pro Monthly', defaultDuration: 30 * 86400 },
  { slug: 'pro-yearly',  name: 'Pro Yearly',  defaultDuration: 365 * 86400 },
  { slug: 'lifetime',    name: 'Lifetime',    defaultDuration: 0 },
] as const;

const productIds: Record<string, string> = {};
for (const p of PRODUCTS) productIds[p.slug] = deriveProductIdHex(p.slug);

console.log('\nRegistered products:');
for (const [slug, id] of Object.entries(productIds)) {
  console.log(`  ${slug} -> ${id.slice(0, 16)}...`);
}

// ---------------------------------------------------------------------------
// Starfish destination
// ---------------------------------------------------------------------------
const starfishClient = new StarfishClient({ baseUrl: STARFISH_URL });

const dest = createStarfishDestination({
  client: starfishClient,
  products: [...PRODUCTS],
  signerKey: STARFISH_SIGNER_KEY,
  logger,
});

// ---------------------------------------------------------------------------
// Mock bridges (accept any JSON payload)
// ---------------------------------------------------------------------------
function createMockBridge(store: 'stripe' | 'apple' | 'google') {
  return {
    async handleNotification(headers: Record<string, string>, body: Buffer) {
      const parsed = JSON.parse(body.toString('utf-8'));

      const productSlug = parsed.productSlug ?? 'pro-monthly';
      const productId = productIds[productSlug] ?? deriveProductIdHex(productSlug);
      const user = parsed.user ?? parsed.userWallet ?? 'default-user';
      const type = parsed.type ?? 'initial_purchase';
      const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;

      const notification: StoreNotification = {
        id: parsed.id ?? `${store}_${Date.now()}`,
        type,
        store,
        environment: parsed.environment ?? 'production',
        productId,
        userWallet: user,
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
        instruction = { productId, user, expiresAt, source: store, sourceId: notification.originalTransactionId };
      } else if (['revocation', 'refund', 'expiration'].includes(type)) {
        instruction = { productId, user, reason: `${store}:${type}` };
      }

      return { notification, instruction };
    },
  };
}

// ---------------------------------------------------------------------------
// Doubloon server
// ---------------------------------------------------------------------------
const doubloon = createDoubloonServer({
  chain: { reader: dest.reader, writer: dest.writer, signer: dest.signer },
  bridges: {
    stripe: createMockBridge('stripe'),
    apple:  createMockBridge('apple'),
    google: createMockBridge('google'),
  },
  onMintFailure: async (instruction, error, ctx) => {
    logger.error(`Mint failed: ${error.message}`, { store: ctx.store, user: instruction.user });
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

    const checkMatch = url.pathname.match(/^\/check\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && checkMatch) {
      const [, productSlug, user] = checkMatch;
      const pid = productIds[productSlug] ?? productSlug;
      const check = await doubloon.checkEntitlement(pid, user);
      jsonResponse(res, 200, check);
      return;
    }

    if (method === 'GET' && url.pathname === '/health') {
      jsonResponse(res, 200, { status: 'ok', starfishUrl: STARFISH_URL });
      return;
    }

    jsonResponse(res, 404, { error: 'Not found' });
  } catch (err) {
    logger.error('Request error', { url: url.pathname, error: err });
    jsonResponse(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\nDoubloon dev server → http://localhost:${PORT}`);
  console.log(`Starfish backend   → ${STARFISH_URL}`);
  console.log('\nEndpoints:');
  console.log(`  POST http://localhost:${PORT}/webhook`);
  console.log(`  GET  http://localhost:${PORT}/check/{productSlug}/{user}`);
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log('');
});

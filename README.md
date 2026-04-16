<p align="center">
  <a href="#doubloon">
    <img src="logo.png" alt="Doubloon" width="400">
  </a>
</p>

<h1 align="center">Doubloon</h1>

<p align="center">
  <strong>Entitlements for every payment rail.</strong>
</p>

<p align="center">
  Doubloon bridges app store purchases, subscription billing, and open payment protocols to your entitlement backend. One integration handles Apple, Google, Stripe, and HTTP 402 — writing entitlements to a <a href="https://github.com/Drakkar-Software/Starfish">Starfish</a> document store that your app can check in milliseconds.
</p>

```
Apple App Store ──┐
Google Play ──────┤                  ┌─── Starfish
Stripe Billing ───┼── Doubloon ──────┤   (document sync)
HTTP 402 (x402) ──┘   Server         └─── (custom destination)
```

---

## Packages

| Package | Description |
|---------|-------------|
| `@doubloon/core` | Shared types, `ProductRegistry`, error codes, utilities |
| `@doubloon/server` | Webhook handler, `defineConfig`, `createNamespacedServer`, dedup, rate limiter, reconciliation |
| `@doubloon/starfish` | Starfish entitlement destination — pull-modify-push with OCC retry |
| `@doubloon/auth` | SIWS authentication, session tokens |
| `@doubloon/bridge-apple` | Apple App Store Server Notifications V2 |
| `@doubloon/bridge-google` | Google Play Real-Time Developer Notifications |
| `@doubloon/bridge-stripe` | Stripe webhook events with signature verification |
| `@doubloon/bridge-x402` | HTTP 402 Payment Required protocol |

---

## Quick Start

```bash
pnpm add @doubloon/server @doubloon/starfish @doubloon/bridge-stripe
```

```typescript
import { defineConfig, createServer } from '@doubloon/server';
import { createStarfishDestination } from '@doubloon/starfish';
import { StripeBridge } from '@doubloon/bridge-stripe';

const PRODUCTS = [
  { slug: 'pro-monthly', name: 'Pro Monthly', defaultDuration: 2592000 },
  { slug: 'lifetime',    name: 'Lifetime',    defaultDuration: 0 },
];

const dest = createStarfishDestination({
  client: starfishClient,      // @drakkar.software/starfish-client
  products: PRODUCTS,
  signerKey: 'my-admin-key',
});

const { serverConfig, registry } = defineConfig({
  products: PRODUCTS,
  destination: dest,
  bridges: {
    stripe: new StripeBridge({
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      productResolver,
      walletResolver,
    }),
  },
  onMintFailure: async (instr, err) => console.error(err.message),
});

const server = createServer(serverConfig);

// Handle webhooks
app.post('/webhook', async (req, res) => {
  const result = await server.handleWebhook({
    headers: req.headers as Record<string, string>,
    body: req.body,
  });
  res.status(result.status).send(result.body);
});

// Check entitlements
const check = await server.checkEntitlement(registry.getProductId('pro-monthly'), userId);
if (check.entitled) {
  // grant access
}
```

---

## Starfish Destination

[Starfish](https://github.com/Drakkar-Software/Starfish) is a document-sync server. `@doubloon/starfish` stores entitlements as a per-user JSON document:

```json
{ "features": ["pro-monthly", "lifetime"] }
```

### Pull-modify-push with OCC

Every write is a pull-modify-push cycle:

1. **Writer** — pulls the document, adds/removes the slug, returns a pending `StarfishTransaction`
2. **Signer** — pushes the transaction. If the document changed (409 Conflict), `mintWithRetry` automatically re-runs the full cycle

```typescript
import { createStarfishDestination } from '@doubloon/starfish';

const dest = createStarfishDestination({
  client: starfishClient,
  products: PRODUCTS,
  signerKey: 'my-admin-key',
  // storagePath: 'users/{user}/entitlements',  // default
  // field: 'features',                         // default
});

// dest.reader   — ChainReader (checkEntitlement, checkEntitlements, getProduct)
// dest.writer   — ChainWriter (mintEntitlement, revokeEntitlement)
// dest.signer   — ChainSigner (signAndSend, publicKey)
// dest.registry — ProductRegistry (slug ↔ productId)
```

### Entitlement model

Starfish entitlements have no per-feature expiry — `expiresAt` is always `null`. Expiry enforcement requires external revocation (via a cancellation webhook) or a reconciliation job.

### Client-side checks

On the client, use `pullEntitlements` from `@drakkar.software/starfish-client` directly:

```typescript
import { pullEntitlements } from '@drakkar.software/starfish-client';

const features = await pullEntitlements(starfishClient, userId);
if (features.includes('pro-monthly')) {
  // unlock premium UI
}
```

---

## `defineConfig`

Declarative wiring of products, destination, and bridges.

```typescript
import { defineConfig, createServer } from '@doubloon/server';

const { serverConfig, registry } = defineConfig({
  products: PRODUCTS,
  destination: dest,          // any { reader, writer, signer }
  bridges: { stripe, apple },
  hooks: {
    afterMint: async (instr, txSig) => analytics.track('mint', instr),
  },
  onMintFailure: async (instr, err) => alerting.send(err),
  mintRetry: { maxRetries: 5, baseDelayMs: 50, maxDelayMs: 2000 },
});
```

- Validates slugs (lowercase alphanumeric + hyphens, no duplicates)
- Derives deterministic `productId` from each slug via SHA-256
- Returns `serverConfig` (for `createServer`) and `registry` (for slug/productId lookups)

---

## Namespace Support

One server for multiple independent apps.

```typescript
import { createNamespacedServer } from '@doubloon/server';

const ns = createNamespacedServer({
  namespaces: {
    'app-prod': {
      products: prodProducts,
      destination: createStarfishDestination({ client, products: prodProducts, signerKey: 'key' }),
      bridges: { stripe, apple },
    },
    'app-staging': {
      products: stagingProducts,
      destination: stagingDest,
    },
  },
  onMintFailure: async (instr, err) => console.error(err),
});

app.all('*', async (req, res) => {
  const result = await ns.handleRequest({
    method: req.method, url: req.url,
    headers: req.headers as Record<string, string>,
    body: req.body,
  });
  res.status(result.status).send(result.body);
});
```

| Method | Path | Action |
|--------|------|--------|
| `POST` | `/{namespace}/webhook` | Route webhook to namespace |
| `GET` | `/{namespace}/check/{productId}/{user}` | Check entitlement |
| `GET` | `/{namespace}/health` | Health check |

Namespace names: `a-z A-Z 0-9 _ -`. Reserved: `webhook`, `check`, `health`, `products`, `entitlements`, `batch`.

---

## Architecture

### Webhook Flow

```
Store sends webhook
       |
       v
  detectStore()          — Routes by header/body pattern
       |
       v
  Rate Limiter           — 60 req/min per IP (configurable)
       |
       v
  Bridge.handleNotification()
    - Verify signature   — Stripe HMAC, Apple JWS, Google JWT
    - Parse notification — Normalize to StoreNotification
    - Resolve product    — Map store SKU → productId
    - Resolve user       — Map store user → identity
    - Build instruction  — MintInstruction or RevokeInstruction
       |
       v
  Deduplication          — Atomic check-and-mark (in-memory default)
       |
       v
  processInstruction()
    - beforeMint hook    — Optional gate (return false to reject)
    - mintWithRetry()    — Writer.mintEntitlement + Signer.signAndSend
                           (Starfish: retries full pull-push on OCC 409)
    - afterMint hook     — Post-processing (analytics, notifications)
       |
       v
  Return 200 OK
```

### Custom Destination

Any object satisfying `DestinationLike` works:

```typescript
import type { DestinationLike } from '@doubloon/server';

const myDest: DestinationLike = {
  reader: {
    async checkEntitlement(productId, user) { /* ... */ },
    async checkEntitlements(productIds, user) { /* ... */ },
    async getEntitlement(productId, user) { /* ... */ },
    async getProduct(productId) { /* ... */ },
  },
  writer: {
    async mintEntitlement(params) { /* return tx */ },
    async revokeEntitlement(params) { /* return tx */ },
  },
  signer: {
    async signAndSend(tx) { /* return txId */ },
    publicKey: 'my-signer-id',
  },
};
```

---

## Authentication

### Sign In With Solana (SIWS)

```typescript
import { createSIWSMessage, verifySIWS } from '@doubloon/auth';

const { message, nonce } = createSIWSMessage(
  { domain: 'app.example.com', statement: 'Sign in to My App' },
  walletAddress,
);

const { wallet, expiresAt } = verifySIWS(message, signature, nonce, 'app.example.com');
```

### Session Tokens

```typescript
import { createSessionToken, verifySessionToken } from '@doubloon/auth';

const token = createSessionToken(walletAddress, serverSecretKey, 60);
const { wallet, expiresAt } = verifySessionToken(token, serverPublicKey);
```

---

## Development

```bash
pnpm install
pnpm build
pnpm test        # per-package unit tests
pnpm test:e2e    # root integration tests (161 tests, 9 suites)

# Dev server (requires a running Starfish instance)
STARFISH_URL=http://localhost:3000 STARFISH_SIGNER_KEY=dev-key pnpm dev
```

### Project Structure

```
packages/
  core/         — Shared types, ProductRegistry, utilities
  server/       — Webhook server, defineConfig, namespaced server, dedup, rate limiter
  starfish/     — Starfish destination (pull-modify-push, OCC retry)
  auth/         — SIWS, session tokens
  bridges/
    apple/      — Apple App Store bridge
    google/     — Google Play bridge
    stripe/     — Stripe bridge
    x402/       — HTTP 402 bridge
tests/          — E2E integration tests (161 tests, 9 suites)
scripts/
  run-server.ts — Local dev server (Starfish-backed)
```

---

## License

See [LICENSE](./LICENSE) for details.

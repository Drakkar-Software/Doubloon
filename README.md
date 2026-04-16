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
  Doubloon bridges app store purchases, subscription billing, and open payment protocols to your entitlement backend. One integration handles Apple, Google, Stripe, and HTTP 402 — writing entitlements to <a href="https://github.com/Drakkar-Software/Starfish">Starfish</a> or Supabase, whichever your app already uses.
</p>

```
Apple App Store ──┐
Google Play ──────┤                  ┌─── Starfish  (document sync)
Stripe Billing ───┼── Doubloon ──────┼─── Supabase  (Anchor-compatible rows)
HTTP 402 (x402) ──┤   Server         └─── custom destination
Custom Store ─────┘
```

---

## Packages

| Package | Description |
|---------|-------------|
| `@drakkar.software/doubloon-core` | Shared types, `ProductRegistry`, `WalletResolver`, error codes, utilities |
| `@drakkar.software/doubloon-server` | Webhook handler, `defineConfig`, `createNamespacedServer`, dedup, rate limiter, reconciliation |
| `@drakkar.software/doubloon-starfish` | Starfish entitlement destination — pull-modify-push with OCC retry |
| `@drakkar.software/doubloon-anchor` | Supabase entitlement destination — full rows with expiry, source, revocation |
| `@drakkar.software/doubloon-bridge-apple` | Apple App Store Server Notifications V2 |
| `@drakkar.software/doubloon-bridge-google` | Google Play Real-Time Developer Notifications |
| `@drakkar.software/doubloon-bridge-stripe` | Stripe webhook events with signature verification |
| `@drakkar.software/doubloon-bridge-x402` | HTTP 402 Payment Required protocol |

---

## Quick Start

```bash
pnpm add @drakkar.software/doubloon-server @drakkar.software/doubloon-starfish @drakkar.software/doubloon-bridge-stripe
```


```typescript
import { defineConfig, createServer } from '@drakkar.software/doubloon-server';
import { createStarfishDestination } from '@drakkar.software/doubloon-starfish';
import { StripeBridge } from '@drakkar.software/doubloon-bridge-stripe';

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

[Starfish](https://github.com/Drakkar-Software/Starfish) is a document-sync server. `@drakkar.software/doubloon-starfish` stores entitlements as a per-user JSON document:

```json
{ "features": ["pro-monthly", "lifetime"] }
```

### Pull-modify-push with OCC

Every write is a pull-modify-push cycle:

1. **Writer** — pulls the document, adds/removes the slug, returns a pending `StarfishTransaction`
2. **Signer** — pushes the transaction. If the document changed (409 Conflict), `mintWithRetry` automatically re-runs the full cycle

```typescript
import { createStarfishDestination } from '@drakkar.software/doubloon-starfish';

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

## Anchor Destination

`@drakkar.software/doubloon-anchor` stores entitlements as rows in a Supabase table with full metadata — expiry, source, revocation. The schema is compatible with [`@drakkar.software/anchor`](https://github.com/Drakkar-Software/Anchor) so client-side Anchor stores can read the same table directly.

```bash
pnpm add @drakkar.software/doubloon-anchor @supabase/supabase-js
```

```typescript
import { createClient } from '@supabase/supabase-js';
import { createAnchorDestination } from '@drakkar.software/doubloon-anchor';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

const dest = createAnchorDestination({
  supabase,
  products: PRODUCTS,
  signerKey: 'service-role',
  // tableName: 'entitlements',  // default
});

const { serverConfig } = defineConfig({
  products: PRODUCTS,
  destination: dest,
  bridges: { stripe },
  onMintFailure,
});
```

### Entitlement model

Anchor entitlements are full rows. `checkEntitlement` returns all four reasons:

| Reason | When |
|--------|------|
| `active` | Row exists, `active=true`, not expired |
| `expired` | Row exists, `active=true`, `expires_at` in past |
| `revoked` | Row exists, `active=false` |
| `not_found` | No row for this product+user |

### Schema

Apply `packages/destinations/anchor/schema.sql` to your Supabase project:

```sql
CREATE TABLE entitlements (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  TEXT        NOT NULL,
  user_wallet TEXT        NOT NULL,
  slug        TEXT        NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  auto_renew  BOOLEAN     NOT NULL DEFAULT false,
  source      TEXT        NOT NULL,
  source_id   TEXT        NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  revoked_at  TIMESTAMPTZ,
  revoked_by  TEXT,
  UNIQUE (product_id, user_wallet)
);

CREATE INDEX idx_entitlements_wallet  ON entitlements (user_wallet);
CREATE INDEX idx_entitlements_product ON entitlements (product_id);
```

### Client-side reads with Anchor

```typescript
import { createTableStore } from '@drakkar.software/anchor';

const entitlementsStore = createTableStore({
  supabase,
  table: 'entitlements',
});

const state = entitlementsStore.getState();
await state.fetch({ filters: [{ column: 'user_wallet', op: 'eq', value: userId }] });
const rows = entitlementsStore.getState().rows;
const hasPro = rows.some((r) => r.slug === 'pro-monthly' && r.active);
```

---

## `defineConfig`

Declarative wiring of products, destination, and bridges.

```typescript
import { defineConfig, createServer } from '@drakkar.software/doubloon-server';

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
import { createNamespacedServer } from '@drakkar.software/doubloon-server';

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
                           (Starfish: retries on OCC 409; Anchor: no retry needed)
    - afterMint hook     — Post-processing (analytics, notifications)
       |
       v
  Return 200 OK
```

### Custom Destination

Any object satisfying `DestinationLike` (alias for `Destination`) works:

```typescript
import type { Destination } from '@drakkar.software/doubloon-server';

const myDest: Destination = {
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

### Custom Bridge

Any payment source can be added by implementing the `Bridge` interface and registering it under an arbitrary key in `bridges`. Route requests to it by setting the `x-doubloon-bridge` header.

```typescript
import type { Bridge } from '@drakkar.software/doubloon-server';
import type { StoreNotification, MintInstruction } from '@drakkar.software/doubloon-core';

const myBridge: Bridge = {
  async handleNotification(headers, body) {
    // 1. Verify the payload (signature, HMAC, etc.)
    const payload = JSON.parse(body.toString());
    if (!verify(payload, headers['x-my-signature'])) {
      throw new Error('Invalid signature');
    }

    // 2. Build a normalized StoreNotification
    const notification: StoreNotification = {
      id: payload.eventId,
      type: 'initial_purchase',
      store: 'my-store',         // arbitrary store name
      environment: 'production',
      productId: resolveProductId(payload.sku),
      userWallet: payload.userId,
      originalTransactionId: payload.txId,
      expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
      autoRenew: payload.recurring ?? false,
      storeTimestamp: new Date(payload.createdAt),
      receivedTimestamp: new Date(),
      deduplicationKey: `my-store:${payload.eventId}`,
      raw: payload,
    };

    // 3. Return a MintInstruction (or RevokeInstruction, or null)
    const instruction: MintInstruction = {
      productId: notification.productId,
      user: notification.userWallet,
      expiresAt: notification.expiresAt,
      source: 'my-store' as any,
      sourceId: payload.txId,
    };

    return { notification, instruction };
  },
};

const { serverConfig } = defineConfig({
  products,
  destination: dest,
  bridges: {
    stripe,               // built-in
    'my-store': myBridge, // custom
  },
  onMintFailure,
});
```

Send webhooks to your custom bridge by including the `x-doubloon-bridge` header:

```bash
curl -X POST https://your-server/webhook \
  -H "x-doubloon-bridge: my-store" \
  -H "x-my-signature: ..." \
  -d '{ "eventId": "...", ... }'
```

The `x-doubloon-bridge` header also works for built-in bridges, bypassing auto-detection.

---

## Webhook Security

Each bridge already performs store-specific signature verification (Stripe HMAC, Apple JWS, Google JWT). For an additional shared-secret layer, set `webhookSecret` in your config:

```typescript
const { serverConfig } = defineConfig({
  products,
  destination: dest,
  webhookSecret: process.env.WEBHOOK_SECRET,  // optional shared secret
  // ...
});
```

When `webhookSecret` is set, every incoming webhook must include the matching value in the `x-doubloon-secret` header. The comparison uses `crypto.timingSafeEqual` to prevent timing attacks. Requests with a missing or wrong header receive `401 Unauthorized`.

```bash
# Send a webhook with the secret
curl -X POST https://your-server/webhook \
  -H "x-doubloon-secret: $WEBHOOK_SECRET" \
  -d '...'
```

---

## Development

```bash
pnpm install
pnpm build
pnpm test        # per-package unit tests
pnpm test:e2e    # root integration tests (10 suites)

# Dev server (requires a running Starfish instance)
STARFISH_URL=http://localhost:3000 STARFISH_SIGNER_KEY=dev-key pnpm dev
```

### Project Structure

```
packages/
  core/              — Shared types, ProductRegistry, WalletResolver, utilities
  server/            — Webhook server, defineConfig, namespaced server, dedup, rate limiter
  destinations/
    starfish/        — Starfish destination (pull-modify-push, OCC retry)
    anchor/          — Supabase destination (full rows, expiry, revocation)
  bridges/
    apple/           — Apple App Store bridge
    google/          — Google Play bridge
    stripe/          — Stripe bridge
    x402/            — HTTP 402 bridge
tests/               — E2E integration tests (9 suites)
scripts/
  run-server.ts      — Local dev server (Starfish-backed)
```

---

## License

See [LICENSE](./LICENSE) for details.

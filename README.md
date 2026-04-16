<p align="center">
  <a href="#doubloon">
    <img src="logo.png" alt="Doubloon" width="400">
  </a>
</p>

<h1 align="center">Doubloon</h1>

<p align="center">
  <strong>Entitlements for every payment rail and every backend.</strong>
</p>

<p align="center">
  Doubloon bridges app store purchases, subscription billing, and open payment protocols to your entitlement backend. One integration handles Apple, Google, Stripe, and HTTP 402 — minting tamper-proof entitlements on Solana, EVM chains, or a Starfish document store that your app can check in milliseconds.
</p>

```
Apple App Store ──┐
Google Play ──────┤                  ┌─── Solana Program
Stripe Billing ───┼── Doubloon ──────┼─── EVM Contract
HTTP 402 (x402) ──┘   Server         └─── Starfish (document sync)
```

---

## Features

- **Multi-store support** -- Apple App Store, Google Play, Stripe, and the x402 payment protocol, all normalized into a single notification flow.
- **Multi-backend** -- Solana (Anchor program), EVM (Solidity contract with ERC-5643 subscription NFTs), and Starfish (document-sync, zero blockchain) out of the box.
- **Starfish destination** -- Store entitlements as `{ features: ["slug"] }` documents. Pull-modify-push with OCC conflict retry. No blockchain required.
- **Coded config (`defineConfig`)** -- Declare products, destination, and bridges in one call. Auto-registers products on local stores; works with any destination.
- **Namespace support** -- One server instance handles multiple apps, each with its own products, destination, and bridges. Shared dedup across namespaces; URL-routed by `/{namespace}/webhook` and `/{namespace}/check/{product}/{wallet}`.
- **Webhook-driven** -- Automatic store detection, signature verification (Apple JWS x5c chain, Stripe HMAC), atomic deduplication, and configurable rate limiting with proxy trust controls.
- **Mint with retry** -- Configurable retry with exponential backoff (capped at 2^30 to prevent overflow), distinguishing transient RPC errors from permanent failures. OCC conflicts from Starfish push are retried automatically.
- **Reconciliation engine** -- Batch drift detection compares store state against on-chain state and corrects mismatches.
- **Delegation system** -- Grant third-party wallets scoped minting authority with expiry and mint caps.
- **SIWS authentication** -- Sign In With Solana message creation, verification with domain binding, message length limits, and Ed25519 session tokens.
- **Pluggable storage** -- In-memory, Redis, Postgres, and S3 adapters for metadata, caching, and deduplication.
- **Local dev chain** -- In-memory chain provider for testing and development without blockchain infrastructure.
- **On-device entitlement checking** -- Lightweight checkers that query chain RPCs directly from mobile, with no server round-trip. Available as TypeScript (React Native/web), Swift (iOS), and Kotlin (Android).
- **Client SDKs** -- React Native, Python, native iOS/Android, and web integration patterns out of the box.

---

## Packages

| Package | Description |
|---------|-------------|
| `@doubloon/core` | Shared types, error codes, `ProductRegistry`, and utilities |
| `@doubloon/server` | Webhook handler, dedup, rate limiter, mint retry, reconciliation, `defineConfig`, `createNamespacedServer` |
| `@doubloon/starfish` | Starfish entitlement destination — pull-modify-push via Starfish document-sync protocol |
| `@doubloon/auth` | SIWS authentication, session tokens, wallet resolver interface |
| `@doubloon/bridge-apple` | Apple App Store Server Notifications V2 |
| `@doubloon/bridge-google` | Google Play Real-Time Developer Notifications |
| `@doubloon/bridge-stripe` | Stripe webhook events with signature verification |
| `@doubloon/bridge-x402` | HTTP 402 Payment Required protocol |
| `@doubloon/solana` | Solana chain reader, writer, PDA derivation, deserialization |
| `@doubloon/evm` | EVM chain reader, writer, ABI, ERC-5643 subscription NFTs |
| `@doubloon/chain-local` | In-memory chain provider for testing and development |
| `@doubloon/storage` | Storage abstractions: `CacheAdapter`, `MetadataStore`, `StoreProductResolver` |
| `@doubloon/storage-redis` | Redis-backed cache adapter (SCAN-based invalidation) |
| `@doubloon/storage-postgres` | Postgres metadata store, wallet resolver, migration SQL |
| `@doubloon/storage-s3` | S3/R2 metadata store for product JSON and binary assets |
| `@doubloon/react-native` | Entitlement cache, receipt packagers, hook types |
| `@doubloon/checker-mobile` | Lightweight on-device chain checker (Solana + EVM via direct RPC) |
| `DoubloonChecker` (Swift) | Native iOS/macOS checker using URLSession + CryptoKit |
| `com.doubloon.checker` (Kotlin) | Native Android checker using OkHttp + coroutines |
| `doubloon` (Python) | Python client for entitlement verification and product ID derivation |

---

## Quick Start

### Install

```bash
# Starfish destination (recommended for most apps)
pnpm add @doubloon/server @doubloon/starfish @doubloon/bridge-stripe

# Solana / EVM chain destinations
pnpm add @doubloon/server @doubloon/bridge-stripe @doubloon/solana
```

### Create a Server with `defineConfig` (recommended)

`defineConfig` is the easiest way to wire up products, a destination, and bridges in one call. It derives product IDs from slugs and returns a ready-to-use `ServerConfig` and `ProductRegistry`.

**With Starfish:**

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
    stripe: new StripeBridge({ webhookSecret: '...', productResolver, walletResolver }),
  },
  onMintFailure: async (instruction, error) => {
    console.error('Mint failed:', error.message);
  },
});

const server = createServer(serverConfig);
const proId = registry.getProductId('pro-monthly'); // deterministic hex
```

**With the local in-memory chain (dev/test):**

```typescript
import { defineConfig, createServer } from '@doubloon/server';
import { createLocalChain } from '@doubloon/chain-local';

const local = createLocalChain();

const { serverConfig } = defineConfig({
  products: PRODUCTS,
  destination: local,          // products auto-registered on local store
  onMintFailure: async () => {},
});

const server = createServer(serverConfig);
```

**Low-level (manual wiring, any chain):**

```typescript
import { createServer } from '@doubloon/server';
import { DoubloonSolanaReader, DoubloonSolanaWriter } from '@doubloon/solana';

const server = createServer({
  chain: {
    reader: new DoubloonSolanaReader({ rpcUrl: 'https://api.mainnet-beta.solana.com' }),
    writer: new DoubloonSolanaWriter({ rpcUrl: 'https://api.mainnet-beta.solana.com' }),
    signer: { signAndSend: mySignerFn, publicKey: 'YourSignerPubkey...' },
  },
  bridges: { stripe: myStripeBridge },
  onMintFailure: async (instruction, error) => console.error(error.message),
});
```

### Handle Webhooks

```typescript
// Express / Fastify / any framework
app.post('/webhooks', async (req, res) => {
  const result = await server.handleWebhook({
    headers: req.headers as Record<string, string>,
    body: req.body,
  });
  res.status(result.status).send(result.body);
});
```

### Check Entitlements

```typescript
const check = await server.checkEntitlement('product-id-hex', 'UserWalletAddress');
if (check.entitled) {
  // Grant access
  console.log('Expires:', check.expiresAt);
}
```

---

## Starfish Destination

[Starfish](https://github.com/Drakkar-Software/Starfish) is a document-sync server. The `@doubloon/starfish` package stores entitlements as a per-user JSON document:

```json
{ "features": ["pro-monthly", "lifetime"] }
```

### How it works

Starfish uses optimistic concurrency control (OCC). Every write is a pull-modify-push cycle:

1. **Writer** (`StarfishWriter`) — pulls the current document, adds or removes the product slug, returns a pending transaction.
2. **Signer** (`StarfishSigner`) — pushes the transaction. If the document changed since the pull (409 Conflict), `mintWithRetry` automatically re-runs the full cycle.

### Install

```bash
pnpm add @doubloon/starfish
pnpm add @drakkar.software/starfish-client  # peer dependency
```

### Usage

```typescript
import { createStarfishDestination } from '@doubloon/starfish';

const dest = createStarfishDestination({
  client: starfishClient,        // StarfishClient instance
  products: PRODUCTS,            // array of { slug, name, defaultDuration }
  signerKey: 'my-admin-key',     // used as signer.publicKey
  // storagePath: 'users/{user}/entitlements',  // default
  // field: 'features',                         // default
});

// dest.reader  — implements ChainReader (checkEntitlement, checkEntitlements, getProduct)
// dest.writer  — implements ChainWriter (mintEntitlement, revokeEntitlement)
// dest.signer  — implements ChainSigner (signAndSend, publicKey)
// dest.registry — ProductRegistry (slug ↔ productId)
```

Pass `dest` directly to `defineConfig()` or `createServer()`:

```typescript
const { serverConfig, registry } = defineConfig({
  products: PRODUCTS,
  destination: dest,
  onMintFailure: async (instr, err) => console.error(err),
});
```

### Entitlement model

Starfish entitlements have no per-feature expiry — `expiresAt` is always `null`. Expiry enforcement requires external revocation (via a cancellation webhook) or a reconciliation job.

### OCC conflict retry

409 conflicts are surfaced as a retryable `DoubloonError`. Use `mintWithRetry` for automatic backoff:

```typescript
import { mintWithRetry } from '@doubloon/server';

const result = await mintWithRetry(
  dest.writer,
  dest.signer,
  { productId, user, expiresAt: null, source: 'stripe', sourceId: 'sub_123' },
  { maxRetries: 5, baseDelayMs: 50, maxDelayMs: 500 },
);
```

---

## Coded Config (`defineConfig`)

`defineConfig` wires products, destination, and bridges into a ready-to-use `ServerConfig`. It lives in `@doubloon/server`.

```typescript
import { defineConfig, createServer } from '@doubloon/server';

const { serverConfig, registry } = defineConfig({
  products: [
    { slug: 'pro-monthly', name: 'Pro Monthly', defaultDuration: 2592000 },
    { slug: 'lifetime',    name: 'Lifetime',    defaultDuration: 0 },
  ],
  destination: dest,          // any DestinationLike: Starfish, LocalChain, custom
  bridges: {
    stripe: stripeBridge,
    apple: appleBridge,
  },
  hooks: {
    afterMint: async (instr, txSig) => analytics.track('mint', instr),
  },
  onMintFailure: async (instr, err) => alerting.send(err),
  mintRetry: { maxRetries: 5, baseDelayMs: 50, maxDelayMs: 2000 },
});

const server = createServer(serverConfig);
```

**What it does:**
- Validates slugs (lowercase alphanumeric + hyphens, no duplicates)
- Derives deterministic `productId` hex from each slug via SHA-256
- Auto-registers products on `LocalChain` stores (duck-typed; no import of `@doubloon/chain-local`)
- Returns both `serverConfig` (for `createServer`) and `registry` (for slug/productId lookups)

---

## Namespace Support (`createNamespacedServer`)

One server instance routing to multiple independent app configurations, each with its own products, destination, and bridges. Lives in `@doubloon/server`.

```typescript
import { createNamespacedServer } from '@doubloon/server';
import { createStarfishDestination } from '@doubloon/starfish';
import { createLocalChain } from '@doubloon/chain-local';

const ns = createNamespacedServer({
  namespaces: {
    'app-prod': {
      products: prodProducts,
      destination: createStarfishDestination({ client, products: prodProducts, signerKey: 'key' }),
      bridges: { stripe: stripeBridge, apple: appleBridge },
    },
    'app-staging': {
      products: stagingProducts,
      destination: createLocalChain(),
    },
  },
  onMintFailure: async (instr, err) => console.error(err),
  // dedup is shared across all namespaces by default
});

// In your HTTP server:
app.all('*', async (req, res) => {
  const result = await ns.handleRequest({
    method: req.method,
    url: req.url,
    headers: req.headers as Record<string, string>,
    body: req.body,
  });
  res.status(result.status).send(result.body);
});
```

### URL routing

| Method | Path | Action |
|--------|------|--------|
| `POST` | `/{namespace}/webhook` | Route webhook to namespace |
| `GET` | `/{namespace}/check/{productId}/{wallet}` | Check entitlement |
| `GET` | `/{namespace}/health` | Health check |
| Any | Unknown namespace | 404 |

### Namespace naming rules

- Characters: `a-z A-Z 0-9 _ -`
- Reserved (will throw): `webhook`, `check`, `health`, `products`, `entitlements`, `batch`

### Programmatic access

```typescript
// Direct namespace server
const appProd = ns.getNamespace('app-prod');
await appProd?.processInstruction(/* ... */);

// Check entitlement within a namespace
const check = await ns.checkEntitlement('app-prod', productId, wallet);

// List all registered namespaces
console.log(ns.namespaces()); // ['app-prod', 'app-staging']
```

---

## Client Guides

### Web

Web apps check entitlements by calling your backend, which delegates to the Doubloon server. Expose a simple API endpoint and call it from the browser with `fetch`.

**Backend endpoint:**

```typescript
import { createServer } from '@doubloon/server';

const server = createServer({ /* ... chain, bridges config */ });

// Express / Fastify / any framework
app.get('/api/entitlements/:productId', async (req, res) => {
  const wallet = req.query.wallet as string;
  const check = await server.checkEntitlement(req.params.productId, wallet);
  res.json(check);
});
```

**Frontend usage:**

```typescript
async function checkAccess(productId: string, wallet: string): Promise<boolean> {
  const res = await fetch(`/api/entitlements/${productId}?wallet=${wallet}`);
  const check = await res.json();
  return check.entitled;
}

// Gate a feature
const hasAccess = await checkAccess('a1b2c3...', '0xUserWallet');
if (hasAccess) {
  showPremiumContent();
}
```

**With caching (recommended for SPAs):**

```typescript
const cache = new Map<string, { entitled: boolean; expiry: number }>();

async function checkAccessCached(productId: string, wallet: string): Promise<boolean> {
  const key = `${productId}:${wallet}`;
  const cached = cache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.entitled;

  const res = await fetch(`/api/entitlements/${productId}?wallet=${wallet}`);
  const check = await res.json();

  cache.set(key, {
    entitled: check.entitled,
    expiry: Date.now() + (check.expiresAt ? new Date(check.expiresAt).getTime() - Date.now() : 30_000),
  });

  return check.entitled;
}
```

---

### React Native

Install the client SDK alongside your chain reader:

```bash
pnpm add @doubloon/react-native @doubloon/core
```

**Check entitlements with caching:**

```typescript
import { EntitlementCache, createEntitlementChecker } from '@doubloon/react-native';

// Create a cache (30s TTL, max 1000 entries)
const cache = new EntitlementCache({ defaultTtlMs: 30_000, maxEntries: 1000 });

// Create a checker backed by your server API
const checker = createEntitlementChecker({
  reader: {
    async checkEntitlement(productId, wallet) {
      // Check cache first
      const cached = cache.get(productId, wallet);
      if (cached) return cached;

      // Fetch from backend
      const res = await fetch(`https://api.myapp.com/entitlements/${productId}?wallet=${wallet}`);
      const check = await res.json();

      // Cache the result (TTL auto-clamped to entitlement expiry)
      cache.set(productId, wallet, check);
      return check;
    },
  },
});

// Use in your app
const check = await checker.check('product-id-hex', walletAddress);
if (check.entitled) {
  // Unlock premium features
}

// Batch check multiple products
const results = await checker.checkBatch(['product-a', 'product-b'], walletAddress);
```

**Package store receipts for webhook submission:**

```typescript
import { packageAppleReceipt, packageGoogleReceipt } from '@doubloon/react-native';

// After an Apple in-app purchase
const appleReceipt = packageAppleReceipt(jwsTransactionPayload);
await fetch('https://api.myapp.com/webhooks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(appleReceipt),
});

// After a Google Play purchase
const googleReceipt = packageGoogleReceipt(purchaseToken, 'com.myapp.premium');
await fetch('https://api.myapp.com/webhooks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(googleReceipt),
});
```

> **Namespaced server:** If using `createNamespacedServer`, prefix the path with your namespace:
> `POST https://api.myapp.com/{namespace}/webhook`

**Hook type signatures** for building custom React hooks:

```typescript
import type { UseEntitlementConfig, UseEntitlementResult } from '@doubloon/react-native';

function useEntitlement(config: UseEntitlementConfig): UseEntitlementResult {
  // Your React hook implementation using config.reader.checkEntitlement
  // Returns { loading, entitled, check, error, refresh }
}
```

---

### On-Device Chain Checking (No Server Required)

For latency-sensitive mobile apps, Doubloon provides lightweight checkers that query Solana or EVM RPCs directly from the device. No server round-trip needed — just your app talking to the blockchain.

**TypeScript (React Native / Web):**

```bash
pnpm add @doubloon/checker-mobile
# Peer dependencies for Solana PDA derivation:
pnpm add @noble/hashes @noble/curves
```

```typescript
import { MobileSolanaChecker, MobileEvmChecker } from '@doubloon/checker-mobile';

// Solana
const solanaChecker = new MobileSolanaChecker({
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  programId: 'YourProgramId...',
});

const check = await solanaChecker.checkEntitlement(productIdHex, walletBase58);
if (check.entitled) {
  // Grant access — no server needed
}

// EVM (zero additional dependencies)
const evmChecker = new MobileEvmChecker({
  rpcUrl: 'https://eth.llamarpc.com',
  contractAddress: '0xYourContract...',
});

const evmCheck = await evmChecker.checkEntitlement(productIdHex, userAddress);

// Batch check multiple products (single RPC call on Solana)
const batch = await solanaChecker.checkEntitlements(
  ['product-a-hex', 'product-b-hex'],
  walletBase58,
);
```

Both checkers implement the `ChainReader` interface from `@doubloon/core`, so they're drop-in replacements for the full Solana/EVM readers.

**Swift (iOS / macOS):**

Add the Swift package from `packages/clients/ios/` to your Xcode project.

```swift
import DoubloonChecker

// Solana
let solana = SolanaChecker(
    rpcUrl: URL(string: "https://api.mainnet-beta.solana.com")!,
    programId: "YourProgramId..."
)

let check = try await solana.checkEntitlement(productId: "a7f3c9...", wallet: "Base58Wallet...")
if check.entitled {
    // Grant access
}

// EVM
let evm = EvmChecker(
    rpcUrl: URL(string: "https://eth.llamarpc.com")!,
    contractAddress: "0xYourContract..."
)

let evmCheck = try await evm.checkEntitlement(productId: "a7f3c9...", wallet: "0xUser...")

// Batch check (concurrent with Swift TaskGroup)
let results = try await solana.checkEntitlements(
    productIds: ["product-a-hex", "product-b-hex"],
    wallet: "Base58Wallet..."
)
```

**Kotlin (Android):**

Add the module from `packages/clients/android/` to your Gradle project.

```kotlin
import com.doubloon.checker.*

// Solana
val solana = SolanaChecker(
    rpcUrl = "https://api.mainnet-beta.solana.com",
    programId = "YourProgramId..."
)

val check = solana.checkEntitlement("a7f3c9...", "Base58Wallet...")
if (check.entitled) {
    // Grant access
}

// EVM
val evm = EvmChecker(
    rpcUrl = "https://eth.llamarpc.com",
    contractAddress = "0xYourContract..."
)

val evmCheck = evm.checkEntitlement("a7f3c9...", "0xUser...")

// Batch check (concurrent with coroutines)
val results = solana.checkEntitlements(
    listOf("product-a-hex", "product-b-hex"),
    "Base58Wallet..."
)
```

All three implementations (TypeScript, Swift, Kotlin) include:
- Full Solana PDA derivation (SHA-256 + ed25519 off-curve check)
- Binary account deserialization matching the on-chain layout
- EVM ABI encoding/decoding for Doubloon contract view functions
- The same pure `checkEntitlement()` logic as the server

---

### Python

Install the Python client:

```bash
pip install doubloon
```

**Derive product IDs (matches the TypeScript implementation):**

```python
from doubloon import derive_product_id_hex, validate_slug

# Human-readable slug -> deterministic 64-char hex ID
product_id = derive_product_id_hex("pro-monthly")
# => "a7f3c9..." (SHA-256 of the slug)
```

**Check entitlements locally (pure function, no I/O):**

```python
from datetime import datetime, timedelta
from doubloon import Entitlement, check_entitlement, check_entitlements

# Build an entitlement from your database or API response
entitlement = Entitlement(
    product_id="a7f3c9...",
    user="0xUserWallet",
    granted_at=datetime(2024, 1, 1),
    expires_at=datetime.utcnow() + timedelta(days=30),
    auto_renew=True,
    source="stripe",
    source_id="sub_abc123",
    active=True,
)

# Check access
result = check_entitlement(entitlement)
if result.entitled:
    print(f"Access granted, expires: {result.expires_at}")
else:
    print(f"Access denied, reason: {result.reason}")

# Batch check multiple products
results = check_entitlements({
    "product-a-hex": entitlement_a,
    "product-b-hex": None,  # Not found
})
for pid, check in results.items():
    print(f"{pid}: {'granted' if check.entitled else check.reason}")
```

**Check entitlements via your backend API:**

```python
import httpx
from doubloon import EntitlementCheck

async def check_access(product_id: str, wallet: str) -> EntitlementCheck:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"https://api.myapp.com/entitlements/{product_id}",
            params={"wallet": wallet},
        )
        data = resp.json()
        return EntitlementCheck(
            entitled=data["entitled"],
            entitlement=None,
            reason=data["reason"],
            expires_at=data.get("expiresAt"),
        )
```

**Available types** (all frozen dataclasses):

| Type | Description |
|------|-------------|
| `Platform` | Platform singleton state (authority, product count, frozen) |
| `Product` | Registered product metadata |
| `Entitlement` | On-chain entitlement record |
| `EntitlementCheck` | Result of checking a single entitlement |
| `MintDelegate` | Delegation granting minting rights |
| `MintInstruction` | Instruction to mint an entitlement |
| `RevokeInstruction` | Instruction to revoke an entitlement |

---

## Architecture

### Webhook Flow

```
Store sends webhook
       |
       v
  detectStore()          -- Routes by header/body pattern
       |
       v
  Rate Limiter           -- 60 req/min per IP (configurable)
       |
       v
  Bridge.handleNotification()
    - Verify signature   -- Stripe HMAC, Apple JWS, Google JWT
    - Parse notification -- Normalize to StoreNotification
    - Resolve product    -- Map store SKU to on-chain product ID
    - Resolve wallet     -- Map store user to blockchain address
    - Build instruction  -- MintInstruction or RevokeInstruction
       |
       v
  Deduplication          -- Always-on (in-memory default, Redis/Postgres optional)
       |
       v
  processInstruction()
    - beforeMint hook    -- Optional gate (return false to reject)
    - mintWithRetry()    -- ChainWriter.mintEntitlement + ChainSigner.signAndSend
                            (Starfish: retries full pull-push cycle on OCC 409)
    - afterMint hook     -- Post-processing (analytics, notifications)
       |
       v
  Return 200 OK
```

### Destination Backends

| Destination | Package | How entitlements are stored | Expiry |
|-------------|---------|----------------------------|--------|
| Solana | `@doubloon/solana` | PDA accounts (on-chain) | `expires_at` field in account |
| EVM | `@doubloon/evm` | ERC-5643 subscription NFTs | NFT expiry via contract |
| Starfish | `@doubloon/starfish` | `{ features: ["slug"] }` document per user | Lifetime (revoke via webhook) |
| Local | `@doubloon/chain-local` | In-memory Map (dev/test) | `expiresAt` field |

### On-Chain Data Model (Solana)

```
Platform (singleton PDA)
  ├── authority: Pubkey
  ├── product_count: u64
  └── frozen: bool

Product (PDA per product_id)
  ├── creator: Pubkey
  ├── product_id: [u8; 32]
  ├── name, metadata_uri
  ├── active, frozen
  ├── entitlement_count: u64
  ├── delegate_count: u32
  └── default_duration: i64

Entitlement (PDA per product + user)
  ├── user: Pubkey
  ├── granted_at, expires_at
  ├── source: u8 (Platform/Creator/Delegate/Apple/Google/Stripe/X402)
  ├── source_id: String
  ├── active, auto_renew
  └── revoked_at, revoked_by

MintDelegate (PDA per product + delegate wallet)
  ├── delegate: Pubkey
  ├── granted_by, expires_at
  ├── max_mints, mints_used
  └── active: bool
```

### Reconciliation

```typescript
import { createReconciliationRunner } from '@doubloon/server';

const runner = createReconciliationRunner({
  writer: solanaWriter,
  signer: mySigner,
});

const report = await runner.run([
  {
    subscriptionId: 'sub_abc',
    bridge: appleBridge,
    currentState: onChainEntitlement,
  },
]);

console.log(`Checked: ${report.checked}, Drifted: ${report.drifted}, Minted: ${report.minted}`);
```

---

## Authentication

### Sign In With Solana (SIWS)

```typescript
import { createSIWSMessage, verifySIWS } from '@doubloon/auth';

// Server creates the challenge
const { message, nonce } = createSIWSMessage(
  { domain: 'app.example.com', statement: 'Sign in to My App' },
  walletAddress,
);

// Client signs with their wallet, server verifies
const { wallet, expiresAt } = verifySIWS(message, signature, nonce, 'app.example.com');
```

### Session Tokens

```typescript
import { createSessionToken, verifySessionToken } from '@doubloon/auth';

const token = createSessionToken(walletAddress, serverSecretKey, 60); // 60 min TTL
const { wallet, expiresAt } = verifySessionToken(token, serverPublicKey);
```

---

## Storage Adapters

### Postgres (Production)

```typescript
import { PostgresMetadataStore, PostgresWalletResolver, MIGRATION_SQL } from '@doubloon/storage-postgres';

// Run migration first
await pool.query(MIGRATION_SQL);

const metadataStore = new PostgresMetadataStore({ pool });
const walletResolver = new PostgresWalletResolver({ pool });
```

### Redis (Caching / Dedup)

```typescript
import { RedisCacheAdapter } from '@doubloon/storage-redis';

const cache = new RedisCacheAdapter({ client: redisClient, prefix: 'dbl:' });
```

### S3 (Assets)

```typescript
import { S3MetadataStore } from '@doubloon/storage-s3';

const store = new S3MetadataStore({
  client: s3Client,
  bucket: 'my-doubloon-bucket',
  publicUrlBase: 'https://cdn.example.com',
});
```

---

## Local Development

### In-Memory Chain (No Blockchain Required)

The simplest path — `defineConfig` auto-registers products:

```typescript
import { defineConfig, createServer } from '@doubloon/server';
import { createLocalChain } from '@doubloon/chain-local';

const PRODUCTS = [
  { slug: 'pro-monthly', name: 'Pro Monthly', defaultDuration: 2592000 },
];

const local = createLocalChain();

const { serverConfig } = defineConfig({
  products: PRODUCTS,
  destination: local,   // products auto-registered, no manual registerProduct call
  onMintFailure: async () => {},
});

const server = createServer(serverConfig);

// Seed test data directly
local.store.mintEntitlement({
  productId: 'a1b2c3...',
  user: '0xTestUser',
  expiresAt: new Date('2030-01-01'),
  source: 'stripe',
  sourceId: 'sub_test_123',
});

// Reset between tests
local.store.clear();
```

Low-level (manual product registration):

```typescript
import { createLocalChain } from '@doubloon/chain-local';
import { createServer } from '@doubloon/server';

const local = createLocalChain();

local.writer.registerProduct({
  productId: 'a1b2c3...',
  name: 'Pro Plan',
  metadataUri: 'https://example.com/pro.json',
  defaultDuration: 2592000,
  signer: local.signer.publicKey,
});

const server = createServer({
  chain: { reader: local.reader, writer: local.writer, signer: local.signer },
  bridges: { /* your bridges */ },
  onMintFailure: async () => {},
});
```

---

## Solana Program

The Anchor program lives in `packages/chains/solana/program/` and provides these instructions:

| Instruction | Description |
|-------------|-------------|
| `initialize_platform` | Create the singleton platform account |
| `register_product` | Register a new product (platform authority only) |
| `mint_entitlement` | Mint or reactivate an entitlement for a user |
| `extend_entitlement` | Extend an existing entitlement's expiry |
| `revoke_entitlement` | Revoke a user's entitlement |
| `close_entitlement` | Close an expired entitlement account and reclaim rent |
| `grant_delegation` | Grant a wallet scoped minting authority |
| `revoke_delegation` | Revoke a delegation and close the account |
| `freeze_product` / `unfreeze_product` | Platform-level product freeze |
| `deactivate_product` / `reactivate_product` | Creator-level product toggle |
| `transfer_platform_authority` | Transfer platform ownership |

### Deploy

```bash
npx tsx scripts/deploy-program.ts --cluster devnet
```

---

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run unit tests (per-package)
pnpm test

# Run e2e tests (root tests/ folder)
pnpm test:e2e

# Run advanced experiments (stress tests, fuzz tests)
pnpm vitest run --config experiments/advanced/vitest.config.ts

# Generate Python types and JSON Schema
npx tsx scripts/codegen.ts --target all --out generated/
```

### CI / CD

The project uses GitHub Actions (`.github/workflows/ci.yml`):

- **Build & Test** — runs unit + e2e tests on Node 20 and 22
- **Lint** — runs ESLint across all packages
- **Publish** — publishes all packages to npm on push to `main` (requires `NPM_TOKEN` secret)

### Project Structure

```
packages/
  core/                  # Shared types, ProductRegistry, and utilities
  server/                # Webhook server, defineConfig, namespaced server, dedup, rate limiter, reconciliation
  starfish/              # Starfish entitlement destination (pull-modify-push, OCC retry)
  auth/                  # SIWS, session tokens, wallet resolver
  bridges/
    apple/               # Apple App Store bridge
    google/              # Google Play bridge
    stripe/              # Stripe bridge
    x402/                # HTTP 402 bridge
  chains/
    solana/              # Solana reader, writer, Anchor program
    evm/                 # EVM reader, writer, ABI, ERC-5643
    local/               # In-memory chain for testing/dev
  storage/
    core/                # Storage interfaces, in-memory adapters
    redis/               # Redis cache adapter
    postgres/            # Postgres metadata + wallet store
    s3/                  # S3 metadata store
  clients/
    react-native/        # Mobile client SDK
    checker-mobile/      # Lightweight on-device chain checker (TS)
    ios/                 # Native iOS/macOS checker (Swift)
    android/             # Native Android checker (Kotlin)
    python/              # Python client
experiments/
  advanced/              # Stress tests, fuzz tests, throughput benchmarks (52 tests)
tests/                   # E2E integration tests (515 tests across 30 suites)
scripts/
  deploy-program.ts      # Solana program deployment
  codegen.ts             # Type generation (Python, JSON Schema)
```

---

## License

See [LICENSE](./LICENSE) for details.

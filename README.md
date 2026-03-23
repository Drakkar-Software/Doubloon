# Doubloon

**On-chain entitlements for every payment rail.** Doubloon bridges app store purchases, subscription billing, and open payment protocols to blockchain-native access control. One integration handles Apple, Google, Stripe, and HTTP 402 -- minting tamper-proof entitlements on Solana or EVM chains that your app can check in milliseconds.

```
Apple App Store ──┐
Google Play ──────┤                  ┌─── Solana Program
Stripe Billing ───┼── Doubloon ──────┤
HTTP 402 (x402) ──┘   Server         └─── EVM Contract
```

---

## Features

- **Multi-store support** -- Apple App Store, Google Play, Stripe, and the x402 payment protocol, all normalized into a single notification flow.
- **Multi-chain** -- Solana (Anchor program) and EVM (Solidity contract with ERC-5643 subscription NFTs) out of the box.
- **Webhook-driven** -- Automatic store detection, signature verification, deduplication, and rate limiting.
- **Mint with retry** -- Configurable retry with exponential backoff, distinguishing transient RPC errors from permanent failures.
- **Reconciliation engine** -- Batch drift detection compares store state against on-chain state and corrects mismatches.
- **Delegation system** -- Grant third-party wallets scoped minting authority with expiry and mint caps.
- **SIWS authentication** -- Sign In With Solana message creation, verification with domain binding, and Ed25519 session tokens.
- **Pluggable storage** -- In-memory, Redis, Postgres, and S3 adapters for metadata, caching, and deduplication.
- **React Native client** -- Entitlement cache, receipt packaging, and hook interfaces for mobile apps.

---

## Packages

| Package | Description |
|---------|-------------|
| `@doubloon/core` | Shared types, error codes, and utilities |
| `@doubloon/server` | Webhook handler, dedup, rate limiter, mint retry, reconciliation |
| `@doubloon/auth` | SIWS authentication, session tokens, wallet resolver interface |
| `@doubloon/bridge-apple` | Apple App Store Server Notifications V2 |
| `@doubloon/bridge-google` | Google Play Real-Time Developer Notifications |
| `@doubloon/bridge-stripe` | Stripe webhook events with signature verification |
| `@doubloon/bridge-x402` | HTTP 402 Payment Required protocol |
| `@doubloon/solana` | Solana chain reader, writer, PDA derivation, deserialization |
| `@doubloon/evm` | EVM chain reader, writer, ABI, ERC-5643 subscription NFTs |
| `@doubloon/storage` | Storage abstractions: `CacheAdapter`, `MetadataStore`, `StoreProductResolver` |
| `@doubloon/storage-redis` | Redis-backed cache adapter (SCAN-based invalidation) |
| `@doubloon/storage-postgres` | Postgres metadata store, wallet resolver, migration SQL |
| `@doubloon/storage-s3` | S3/R2 metadata store for product JSON and binary assets |
| `@doubloon/react-native` | Entitlement cache, receipt packagers, hook types |

---

## Quick Start

### Install

```bash
pnpm add @doubloon/server @doubloon/bridge-stripe @doubloon/solana
```

### Create a Server

```typescript
import { createServer } from '@doubloon/server';
import { StripeBridge } from '@doubloon/bridge-stripe';
import { DoubloonSolanaReader, DoubloonSolanaWriter } from '@doubloon/solana';

const server = createServer({
  chain: {
    reader: new DoubloonSolanaReader({ rpcUrl: 'https://api.mainnet-beta.solana.com' }),
    writer: new DoubloonSolanaWriter({ rpcUrl: 'https://api.mainnet-beta.solana.com' }),
    signer: { signAndSend: mySignerFn, publicKey: 'YourSignerPubkey...' },
  },
  bridges: {
    stripe: new StripeBridge({
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      productResolver: myProductResolver,
      walletResolver: myWalletResolver,
    }),
  },
  onMintFailure: async (instruction, error, ctx) => {
    console.error('Mint failed:', instruction.productId, error.message);
  },
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
    - afterMint hook     -- Post-processing (analytics, notifications)
       |
       v
  Return 200 OK
```

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

# Run all tests
pnpm test

# Generate Python types and JSON Schema
npx tsx scripts/codegen.ts --target all --out generated/
```

### Project Structure

```
packages/
  core/                  # Shared types and utilities
  server/                # Webhook server, dedup, rate limiter, reconciliation
  auth/                  # SIWS, session tokens, wallet resolver
  bridges/
    apple/               # Apple App Store bridge
    google/              # Google Play bridge
    stripe/              # Stripe bridge
    x402/                # HTTP 402 bridge
  chains/
    solana/              # Solana reader, writer, Anchor program
    evm/                 # EVM reader, writer, ABI, ERC-5643
  storage/
    core/                # Storage interfaces, in-memory adapters
    redis/               # Redis cache adapter
    postgres/            # Postgres metadata + wallet store
    s3/                  # S3 metadata store
  clients/
    react-native/        # Mobile client SDK
scripts/
  deploy-program.ts      # Solana program deployment
  codegen.ts             # Type generation (Python, JSON Schema)
```

---

## License

See [LICENSE](./LICENSE) for details.

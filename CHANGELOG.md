# Changelog

## 0.4.0 / 0.3.1 (2026-06-29)

### Breaking

#### Starfish (`@drakkar.software/doubloon-starfish`) — `0.3.0` → `0.4.0`

- Bumped to `@drakkar.software/starfish-client` **v3** (workspace-linked `3.0.0-alpha.44`). v3 removed `pullEntitlements` from `starfish-client` and moved it to the new `@drakkar.software/starfish-entitlements` package. The Doubloon starfish destination now imports `pullEntitlements` from there.
- **New peer dependency:** `@drakkar.software/starfish-entitlements: >=3.0.0-alpha.0` must be installed alongside `@drakkar.software/starfish-client`.
- Peer range for `starfish-client` tightened to `>=3.0.0-alpha.0` (v3 is now required; `pullEntitlements` does not exist in v1/v2).
- No changes to the public API of `@drakkar.software/doubloon-starfish` — this version bump is solely due to the new required peer.

### Fixes

#### Anchor (`@drakkar.software/doubloon-anchor`) — `0.3.0` → `0.3.1`

- Bumped `@supabase/supabase-js` dev dependency floor from `^2.49.0` to `^2.108.0` (latest stable `2.108.2`). The peer range `>=2.0.0` is unchanged. No source changes — the API surface used (`.from()`, `.upsert()`, `.update()`, `.select()`, `.eq()`, `.in()`, `.maybeSingle()`, `.single()`, `{ data, error }`) is stable across this minor bump.

---

## 0.3.1 (2026-04-18)

### Features

#### Stripe (`@drakkar.software/doubloon-bridge-stripe`)

- `walletValidator?: (address: string) => boolean` — optional custom wallet format check, overrides the default Solana/EVM validation. Consistent with Apple and Google bridges.
- `clientReferenceIdTransform?: (id: string) => string` — optional transform applied to `client_reference_id` before it is used as the wallet address. Enables embedding extra data in the field (e.g. `"{userId}_{weddingId}"` from a Stripe Payment Link URL) while resolving only the wallet part. Raw value remains visible in the Stripe Dashboard and in `notification.raw`.
- `client_reference_id` is now checked in `extractWallet` (before `metadata.wallet`), matching the expected Stripe Payment Link flow.

### Tests

- 2 new tests in `packages/bridges/stripe/__tests__/bridge.test.ts` — plain `client_reference_id` as wallet with custom validator; compound `client_reference_id` with transform.

### Docs

- `docs/bridges/stripe.md`: added `walletValidator` and `clientReferenceIdTransform` to config table; new **Payment Links** section with example.

---

## 0.3.0 (2026-04-17)

### Features

- **Sandbox/testnet environment support** — bridges now correctly label `StoreNotification.environment` and the server can enforce an environment mode.

#### Apple (`@drakkar.software/doubloon-bridge-apple`)

- Environment is now derived from the signed JWS payload (`payload.environment`, fallback `data.environment`) instead of a static config flag. This means a sandbox-signed notification is always labelled `sandbox` regardless of server config.
- `AppleBridgeConfig.environment` is deprecated (kept for backward compatibility, has no effect).

#### Google (`@drakkar.software/doubloon-bridge-google`)

- `subscriptionNotification.testPurchase` presence now sets `environment: 'sandbox'` automatically.
- `oneTimeProductNotification` is now handled: type 1 → `initial_purchase` (mint), type 2 → `cancellation` (no-op). Supports `testPurchase` detection for sandbox labelling.

#### Server (`@drakkar.software/doubloon-server`)

- New `mode?: 'production' | 'sandbox'` option in `defineConfig` / `ServerConfig`. When set, webhooks with a mismatched `environment` are rejected with HTTP 400 before deduplication. Omit to accept both (backward-compatible default).
- `NamespaceConfig` gains per-namespace `mode`, so a single namespaced server can host both a production namespace and a staging namespace.

### Tests

- 5 new tests in `tests/server-mode.test.ts` — mode enforcement, namespaced mode, backward compat.
- 2 new tests in `packages/bridges/apple/__tests__/bridge.test.ts` — deprecated config field, default production env.
- 4 new tests in `packages/bridges/google/__tests__/bridge.test.ts` — testPurchase sandbox labelling, oneTimeProductNotification (purchased + sandbox).

---

## 0.2.0 (2026-04-16)

### New Packages

- **`@drakkar.software/doubloon-anchor`** (`packages/destinations/anchor/`) — Supabase entitlement destination. Stores full entitlement rows with expiry, source, and revocation metadata. Anchor-compatible schema lets client-side `@drakkar.software/anchor` stores read the same table. Uses `@supabase/supabase-js` directly for upsert-with-`onConflict` and composite-filter updates.

  Key capabilities vs Starfish:
  - Four check reasons: `active`, `not_found`, `expired`, `revoked` (Starfish only returns `active`/`not_found`)
  - Real expiry timestamps persisted per entitlement
  - Re-subscribing upserts the existing row (reactivates without creating a duplicate)
  - Revocation stores `revoked_at` and `revoked_by`

  Reference DDL: `packages/destinations/anchor/schema.sql`

### Breaking Changes

- **`@drakkar.software/doubloon-core`**: `Chain` type extended — `'anchor'` added alongside `'starfish'` and `'local'`.

### Other

- Root `package.json`: removed stale `@drakkar.software/doubloon-auth` workspace reference, added `@supabase/supabase-js` dev dependency.
- 19 new e2e tests in `tests/anchor-destination.test.ts` (all 4 check reasons, full lifecycle, mintWithRetry, ProductRegistry).

## 0.1.0 (initial)

- `@drakkar.software/doubloon-core` — shared types, ProductRegistry, WalletResolver, error codes
- `@drakkar.software/doubloon-server` — webhook handler, defineConfig, createNamespacedServer, dedup, rate limiter, reconciliation
- `@drakkar.software/doubloon-starfish` — Starfish destination with pull-modify-push OCC retry
- `@drakkar.software/doubloon-bridge-apple` — Apple App Store Server Notifications V2
- `@drakkar.software/doubloon-bridge-google` — Google Play Real-Time Developer Notifications
- `@drakkar.software/doubloon-bridge-stripe` — Stripe webhook events with signature verification
- `@drakkar.software/doubloon-bridge-x402` — HTTP 402 Payment Required protocol

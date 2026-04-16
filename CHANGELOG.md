# Changelog

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

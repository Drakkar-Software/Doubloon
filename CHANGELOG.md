# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.1.0] — 2026-04-16

Initial release. Starfish-backed entitlement server with multi-store payment bridges.

### Packages

| Package | Description |
|---------|-------------|
| `@doubloon/core` | Shared types, `ProductRegistry`, error codes, utilities |
| `@doubloon/server` | Webhook handler, `defineConfig`, `createNamespacedServer`, dedup, rate limiter, reconciliation |
| `@doubloon/starfish` | Starfish entitlement destination |
| `@doubloon/auth` | SIWS authentication, session tokens |
| `@doubloon/bridge-apple` | Apple App Store Server Notifications V2 |
| `@doubloon/bridge-google` | Google Play Real-Time Developer Notifications |
| `@doubloon/bridge-stripe` | Stripe webhook events |
| `@doubloon/bridge-x402` | HTTP 402 Payment Required protocol |

### Added

#### Core (`@doubloon/core`)
- Shared types: `Chain`, `Store`, `EntitlementSource`, `NotificationType`
- Domain models: `Platform`, `Product`, `Entitlement`, `MintDelegate`
- Instruction types: `MintInstruction`, `RevokeInstruction`, `isMintInstruction`
- `EntitlementCheck`, `EntitlementCheckBatch` result types
- `checkEntitlement`, `checkEntitlements` pure check functions
- `deriveProductIdHex` — deterministic SHA-256 product ID from slug
- `validateSlug` — slug format enforcement (lowercase alphanumeric + hyphens)
- `ProductRegistry` / `createProductRegistry` — bidirectional slug ↔ productId mapping
- `DoubloonError` with typed error codes and retryable flag
- `nullLogger` and `Logger` interface

#### Server (`@doubloon/server`)
- `createServer` — webhook handler with automatic store detection
- `ChainWriter` / `ChainSigner` interfaces for destination backends
- `mintWithRetry` — exponential backoff retry; OCC conflicts retried automatically
- `MemoryDedupStore` / `DedupStore` — atomic check-and-mark dedup with TTL
- Rate limiter — sliding window, 60 req/min default, proxy trust controls
- Reconciliation — `createReconciliationRunner` for batch drift detection and correction
- `defineConfig` — declarative product + destination + bridge wiring
- `createNamespacedServer` — one server for multiple apps, URL-routed by namespace

#### Starfish Destination (`@doubloon/starfish`)
- `createStarfishDestination` — factory returning `{ reader, writer, signer, registry }`
- `StarfishReader` — pulls features via `pullEntitlements()`; synthesizes `Entitlement`
- `StarfishWriter` — pull-modify-prepare: adds/removes slug, returns `StarfishTransaction`
- `StarfishSigner` — executes push; maps `ConflictError` (409) to retryable `DoubloonError`
- Configurable `storagePath` template and `field` name

#### Authentication (`@doubloon/auth`)
- `createSIWSMessage` / `verifySIWS` — Sign In With Solana
- `createSessionToken` / `verifySessionToken` — Ed25519 session tokens with TTL and domain binding

#### Payment Bridges
- `@doubloon/bridge-apple` — Apple App Store Server Notifications V2 (JWS x5c chain verification)
- `@doubloon/bridge-google` — Google Play Real-Time Developer Notifications (JWT verification)
- `@doubloon/bridge-stripe` — Stripe webhook events (HMAC signature verification)
- `@doubloon/bridge-x402` — HTTP 402 Payment Required protocol

#### Testing
- 9 e2e test suites, 161 tests: Starfish lifecycle and OCC retry, defineConfig validation,
  namespace routing and isolation, bridge parsing and signature verification, dedup, rate limiter

#!/usr/bin/env npx tsx
/**
 * Local chain dev playground.
 *
 * Boots a Doubloon server backed by an in-memory chain, seeds sample data,
 * and runs through a full lifecycle — registration, minting, checking,
 * renewal, revocation — to verify everything works end-to-end.
 *
 * Usage:
 *   npx tsx scripts/test-local-chain.ts
 *   npx tsx scripts/test-local-chain.ts --verbose
 */

import { createLocalChain } from '@doubloon/chain-local';
import { createServer } from '@doubloon/server';
import { createEntitlementChecker } from '@doubloon/react-native';
import { deriveProductIdHex } from '@doubloon/core';

const verbose = process.argv.includes('--verbose');

const logger = verbose
  ? { debug: console.log, info: console.log, warn: console.warn, error: console.error }
  : { debug() {}, info() {}, warn: console.warn, error: console.error };

// ──────────────────────────────────────────────
// 1. Boot local chain + server
// ──────────────────────────────────────────────
console.log('\n=== Doubloon Local Chain Test ===\n');

const local = createLocalChain({ logger });
console.log('✓ Local chain created');

const server = createServer({
  chain: {
    reader: local.reader,
    writer: local.writer,
    signer: local.signer,
  },
  bridges: {},
  onMintFailure: async (instruction, error) => {
    console.error(`  ✗ Mint failed: ${instruction.productId} — ${error.message}`);
  },
  logger,
});
console.log('✓ Server created');

// ──────────────────────────────────────────────
// 2. Register products
// ──────────────────────────────────────────────
const proMonthlyId = deriveProductIdHex('pro-monthly');
const proYearlyId = deriveProductIdHex('pro-yearly');
const lifetimeId = deriveProductIdHex('lifetime-pass');

await local.writer.registerProduct({
  productId: proMonthlyId,
  name: 'Pro Monthly',
  metadataUri: 'https://example.com/pro-monthly.json',
  defaultDuration: 30 * 86400,
  signer: local.signer.publicKey,
});

await local.writer.registerProduct({
  productId: proYearlyId,
  name: 'Pro Yearly',
  metadataUri: 'https://example.com/pro-yearly.json',
  defaultDuration: 365 * 86400,
  signer: local.signer.publicKey,
});

await local.writer.registerProduct({
  productId: lifetimeId,
  name: 'Lifetime Pass',
  metadataUri: 'https://example.com/lifetime.json',
  defaultDuration: 0,
  signer: local.signer.publicKey,
});

console.log(`✓ Registered 3 products`);
console.log(`  pro-monthly  → ${proMonthlyId.slice(0, 16)}…`);
console.log(`  pro-yearly   → ${proYearlyId.slice(0, 16)}…`);
console.log(`  lifetime     → ${lifetimeId.slice(0, 16)}…`);

// ──────────────────────────────────────────────
// 3. Mint entitlements
// ──────────────────────────────────────────────
const wallet1 = '0xAlice';
const wallet2 = '0xBob';

// Alice: monthly subscription via Stripe
local.store.mintEntitlement({
  productId: proMonthlyId,
  user: wallet1,
  expiresAt: new Date(Date.now() + 30 * 86400_000),
  source: 'stripe',
  sourceId: 'sub_alice_monthly',
  autoRenew: true,
});

// Alice: lifetime pass
local.store.mintEntitlement({
  productId: lifetimeId,
  user: wallet1,
  expiresAt: null,
  source: 'platform',
  sourceId: 'grant_alice_lifetime',
});

// Bob: yearly via Apple
local.store.mintEntitlement({
  productId: proYearlyId,
  user: wallet2,
  expiresAt: new Date(Date.now() + 365 * 86400_000),
  source: 'apple',
  sourceId: 'txn_bob_yearly',
  autoRenew: true,
});

console.log(`✓ Minted entitlements (${local.store.entitlementCount} total)`);

// ──────────────────────────────────────────────
// 4. Check entitlements via server
// ──────────────────────────────────────────────
console.log('\n--- Entitlement checks via server ---');

const aliceMonthly = await server.checkEntitlement(proMonthlyId, wallet1);
console.log(`  Alice pro-monthly: entitled=${aliceMonthly.entitled}, reason=${aliceMonthly.reason}`);
assert(aliceMonthly.entitled, 'Alice should be entitled to pro-monthly');

const aliceLifetime = await server.checkEntitlement(lifetimeId, wallet1);
console.log(`  Alice lifetime:    entitled=${aliceLifetime.entitled}, reason=${aliceLifetime.reason}`);
assert(aliceLifetime.entitled, 'Alice should be entitled to lifetime');
assert(aliceLifetime.expiresAt === null, 'Lifetime should have no expiry');

const bobYearly = await server.checkEntitlement(proYearlyId, wallet2);
console.log(`  Bob pro-yearly:    entitled=${bobYearly.entitled}, reason=${bobYearly.reason}`);
assert(bobYearly.entitled, 'Bob should be entitled to pro-yearly');

const bobMonthly = await server.checkEntitlement(proMonthlyId, wallet2);
console.log(`  Bob pro-monthly:   entitled=${bobMonthly.entitled}, reason=${bobMonthly.reason}`);
assert(!bobMonthly.entitled, 'Bob should NOT be entitled to pro-monthly');

// ──────────────────────────────────────────────
// 5. Batch checks
// ──────────────────────────────────────────────
console.log('\n--- Batch check ---');

const aliceBatch = await server.checkEntitlements(
  [proMonthlyId, proYearlyId, lifetimeId],
  wallet1,
);
console.log(`  Alice batch: ${Object.keys(aliceBatch.results).length} products checked`);
assert(aliceBatch.results[proMonthlyId].entitled, 'Alice pro-monthly should be entitled');
assert(!aliceBatch.results[proYearlyId].entitled, 'Alice pro-yearly should NOT be entitled');
assert(aliceBatch.results[lifetimeId].entitled, 'Alice lifetime should be entitled');

// ──────────────────────────────────────────────
// 6. Use createEntitlementChecker (React Native SDK)
// ──────────────────────────────────────────────
console.log('\n--- React Native checker SDK ---');

const checker = createEntitlementChecker({ reader: local.reader });

const rnCheck = await checker.check(proMonthlyId, wallet1);
console.log(`  checker.check:     entitled=${rnCheck.entitled}`);
assert(rnCheck.entitled, 'RN checker should return entitled');

const rnBatch = await checker.checkBatch([proMonthlyId, lifetimeId], wallet1);
console.log(`  checker.checkBatch: ${Object.keys(rnBatch).length} results`);
assert(rnBatch[proMonthlyId].entitled, 'RN batch pro-monthly should be entitled');
assert(rnBatch[lifetimeId].entitled, 'RN batch lifetime should be entitled');

// ──────────────────────────────────────────────
// 7. Revocation
// ──────────────────────────────────────────────
console.log('\n--- Revocation ---');

local.store.revokeEntitlement({
  productId: proMonthlyId,
  user: wallet1,
  revokedBy: 'admin',
});

const afterRevoke = await server.checkEntitlement(proMonthlyId, wallet1);
console.log(`  Alice pro-monthly after revoke: entitled=${afterRevoke.entitled}, reason=${afterRevoke.reason}`);
assert(!afterRevoke.entitled, 'Alice should NOT be entitled after revoke');
assert(afterRevoke.reason === 'revoked', 'Reason should be revoked');

// ──────────────────────────────────────────────
// 8. Expired entitlement
// ──────────────────────────────────────────────
console.log('\n--- Expired entitlement ---');

local.store.mintEntitlement({
  productId: proMonthlyId,
  user: '0xCharlie',
  expiresAt: new Date(Date.now() - 1000), // already expired
  source: 'google',
  sourceId: 'txn_charlie_expired',
});

const charlieCheck = await server.checkEntitlement(proMonthlyId, '0xCharlie');
console.log(`  Charlie expired:   entitled=${charlieCheck.entitled}, reason=${charlieCheck.reason}`);
assert(!charlieCheck.entitled, 'Charlie should NOT be entitled');
assert(charlieCheck.reason === 'expired', 'Reason should be expired');

// ──────────────────────────────────────────────
// 9. Renewal (re-mint with new expiry)
// ──────────────────────────────────────────────
console.log('\n--- Renewal ---');

const newExpiry = new Date(Date.now() + 30 * 86400_000);
local.store.mintEntitlement({
  productId: proMonthlyId,
  user: wallet1,
  expiresAt: newExpiry,
  source: 'stripe',
  sourceId: 'sub_alice_monthly_renewal',
  autoRenew: true,
});

const afterRenewal = await server.checkEntitlement(proMonthlyId, wallet1);
console.log(`  Alice after renewal: entitled=${afterRenewal.entitled}, reason=${afterRenewal.reason}`);
assert(afterRenewal.entitled, 'Alice should be entitled after renewal');

// ──────────────────────────────────────────────
// 10. Product metadata retrieval
// ──────────────────────────────────────────────
console.log('\n--- Product retrieval ---');

const product = await local.reader.getProduct(proMonthlyId);
console.log(`  Product: name="${product?.name}", active=${product?.active}, entitlements=${product?.entitlementCount}`);
assert(product !== null, 'Product should exist');
assert(product!.name === 'Pro Monthly', 'Product name should match');

// ──────────────────────────────────────────────
// 11. Store reset
// ──────────────────────────────────────────────
console.log('\n--- Store reset ---');
console.log(`  Before clear: ${local.store.productCount} products, ${local.store.entitlementCount} entitlements`);
local.store.clear();
console.log(`  After clear:  ${local.store.productCount} products, ${local.store.entitlementCount} entitlements`);
assert(local.store.productCount === 0, 'Products should be 0');
assert(local.store.entitlementCount === 0, 'Entitlements should be 0');

// ──────────────────────────────────────────────
// Done
// ──────────────────────────────────────────────
console.log('\n=== All checks passed ===\n');

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`\n  ✗ ASSERTION FAILED: ${message}\n`);
    process.exit(1);
  }
}

/**
 * E2E: @doubloon/checker-mobile utilities against local data.
 *
 * Tests the portable deserialization, base58, hex utils, and product ID
 * derivation from checker-mobile against known-good values from the
 * core package and local chain.
 */
import { describe, it, expect } from 'vitest';
import { deriveProductIdHex as coreDeriveProductIdHex } from '@doubloon/core';
import {
  deriveProductIdHex as mobileDeriveProductIdHex,
  base58Decode,
  base58Encode,
  hexToBytes,
  bytesToHex,
  deserializeSolanaEntitlement,
} from '@doubloon/checker-mobile';

describe('checker-mobile parity with core', () => {
  const slugs = [
    'pro-monthly',
    'pro-yearly',
    'lifetime-pass',
    'team-enterprise',
    'starter-plan',
  ];

  it('deriveProductIdHex matches core implementation for all slugs', () => {
    for (const slug of slugs) {
      const coreId = coreDeriveProductIdHex(slug);
      const mobileId = mobileDeriveProductIdHex(slug);
      expect(mobileId).toBe(coreId);
    }
  });
});

describe('checker-mobile base58 codec', () => {
  it('round-trips the system program address (all zeros)', () => {
    const systemProgram = '11111111111111111111111111111111';
    const decoded = base58Decode(systemProgram);
    expect(decoded.length).toBe(32);
    expect(decoded.every((b) => b === 0)).toBe(true);
    expect(base58Encode(decoded)).toBe(systemProgram);
  });

  it('round-trips a typical pubkey', () => {
    // A known Solana address
    const addr = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const decoded = base58Decode(addr);
    expect(decoded.length).toBe(32);
    expect(base58Encode(decoded)).toBe(addr);
  });

  it('round-trips single-byte values', () => {
    expect(base58Encode(new Uint8Array([0]))).toBe('1');
    expect(base58Encode(new Uint8Array([1]))).toBe('2');
    expect(base58Encode(new Uint8Array([57]))).toBe('z');
  });
});

describe('checker-mobile hex utilities', () => {
  it('hexToBytes and bytesToHex are inverses', () => {
    const hex = 'deadbeef01020304';
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });

  it('handles 32-byte product IDs', () => {
    const id = 'ab'.repeat(32);
    const bytes = hexToBytes(id);
    expect(bytes.length).toBe(32);
    expect(bytesToHex(bytes)).toBe(id);
  });
});

describe('checker-mobile Solana deserialization', () => {
  it('deserializes a synthetic entitlement buffer', () => {
    const productId = 'ab'.repeat(32);
    const user = new Uint8Array(32).fill(1);
    const grantedAt = 1700000000;
    const expiresAt = 1900000000;
    const sourceIdStr = 'sub_test_123';

    const data = buildEntitlementBuffer({
      productId,
      user,
      grantedAt,
      expiresAt,
      autoRenew: true,
      source: 5, // stripe
      sourceId: sourceIdStr,
      active: true,
      revokedAt: 0,
      revokedBy: new Uint8Array(32), // default pubkey
    });

    const entitlement = deserializeSolanaEntitlement(data);
    expect(entitlement.productId).toBe(productId);
    expect(entitlement.active).toBe(true);
    expect(entitlement.autoRenew).toBe(true);
    expect(entitlement.source).toBe('stripe');
    expect(entitlement.sourceId).toBe('sub_test_123');
    expect(entitlement.expiresAt).toEqual(new Date(expiresAt * 1000));
    expect(entitlement.grantedAt).toEqual(new Date(grantedAt * 1000));
    expect(entitlement.revokedAt).toBeNull();
    expect(entitlement.revokedBy).toBeNull();
  });

  it('deserializes lifetime entitlement (expiresAt=0)', () => {
    const data = buildEntitlementBuffer({
      productId: 'cd'.repeat(32),
      user: new Uint8Array(32).fill(2),
      grantedAt: 1700000000,
      expiresAt: 0,
      autoRenew: false,
      source: 0, // platform
      sourceId: 'grant_1',
      active: true,
      revokedAt: 0,
      revokedBy: new Uint8Array(32),
    });

    const entitlement = deserializeSolanaEntitlement(data);
    expect(entitlement.expiresAt).toBeNull();
    expect(entitlement.source).toBe('platform');
  });

  it('deserializes revoked entitlement', () => {
    const revokedBy = new Uint8Array(32).fill(99);
    const data = buildEntitlementBuffer({
      productId: 'ef'.repeat(32),
      user: new Uint8Array(32).fill(3),
      grantedAt: 1700000000,
      expiresAt: 1900000000,
      autoRenew: false,
      source: 3, // apple
      sourceId: 'txn_refund',
      active: false,
      revokedAt: 1750000000,
      revokedBy,
    });

    const entitlement = deserializeSolanaEntitlement(data);
    expect(entitlement.active).toBe(false);
    expect(entitlement.revokedAt).toEqual(new Date(1750000000 * 1000));
    expect(entitlement.revokedBy).not.toBeNull();
    expect(entitlement.source).toBe('apple');
  });
});

// --- Helper ---

function buildEntitlementBuffer(opts: {
  productId: string;
  user: Uint8Array;
  grantedAt: number;
  expiresAt: number;
  autoRenew: boolean;
  source: number;
  sourceId: string;
  active: boolean;
  revokedAt: number;
  revokedBy: Uint8Array;
}): Uint8Array {
  const sourceIdBytes = new TextEncoder().encode(opts.sourceId);
  const size = 8 + 32 + 32 + 8 + 8 + 1 + 1 + 4 + sourceIdBytes.length + 1 + 8 + 32;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let offset = 8; // skip discriminator

  const pidBytes = hexToBytes(opts.productId);
  buf.set(pidBytes, offset); offset += 32;
  buf.set(opts.user, offset); offset += 32;
  view.setBigInt64(offset, BigInt(opts.grantedAt), true); offset += 8;
  view.setBigInt64(offset, BigInt(opts.expiresAt), true); offset += 8;
  buf[offset] = opts.autoRenew ? 1 : 0; offset += 1;
  buf[offset] = opts.source; offset += 1;
  view.setUint32(offset, sourceIdBytes.length, true); offset += 4;
  buf.set(sourceIdBytes, offset); offset += sourceIdBytes.length;
  buf[offset] = opts.active ? 1 : 0; offset += 1;
  view.setBigInt64(offset, BigInt(opts.revokedAt), true); offset += 8;
  buf.set(opts.revokedBy, offset);

  return buf;
}

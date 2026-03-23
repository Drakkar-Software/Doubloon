/**
 * E2E: EVM ABI encoding/decoding — function selectors, bytes32/address
 * encoding, bool/uint64/int64 decoding, dynamic string parsing,
 * full getEntitlement/getProduct tuple decode.
 */
import { describe, it, expect } from 'vitest';
import {
  SELECTORS,
  encodeIsEntitled,
  encodeGetEntitlement,
  encodeGetProduct,
  decodeBool,
  decodeGetEntitlement,
  decodeGetProduct,
} from '@doubloon/checker-mobile';
import type { EvmEntitlementRaw, EvmProductRaw } from '@doubloon/checker-mobile';

/** Encode a string to hex for embedding in ABI data */
function strToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Pad hex to 64-char slot */
function slot(hex: string): string { return hex.padStart(64, '0'); }

/** Encode a number as uint256 slot */
function uint(n: number | bigint): string { return BigInt(n).toString(16).padStart(64, '0'); }

describe('ABI function selectors', () => {
  it('isEntitled selector is 4 bytes hex', () => {
    expect(SELECTORS.isEntitled).toHaveLength(8);
    expect(SELECTORS.isEntitled).toBe('2b1c1e9f');
  });

  it('getEntitlement selector', () => {
    expect(SELECTORS.getEntitlement).toHaveLength(8);
    expect(SELECTORS.getEntitlement).toBe('fdb60e41');
  });

  it('getProduct selector', () => {
    expect(SELECTORS.getProduct).toHaveLength(8);
    expect(SELECTORS.getProduct).toBe('a3e76c0f');
  });
});

describe('ABI encoding', () => {
  it('encodeIsEntitled produces selector + bytes32 + address', () => {
    const productId = 'ab'.repeat(32);
    const address = '0x' + 'ff'.repeat(20);
    const encoded = encodeIsEntitled(productId, address);

    expect(encoded.startsWith(SELECTORS.isEntitled)).toBe(true);
    expect(encoded).toHaveLength(8 + 64 + 64); // selector + 2 slots
    expect(encoded.substring(8, 72)).toBe(productId); // bytes32
    expect(encoded.substring(72)).toContain('ff'.repeat(20)); // address padded
  });

  it('encodeGetEntitlement produces selector + bytes32 + address', () => {
    const encoded = encodeGetEntitlement('aa'.repeat(32), '0x1234567890abcdef1234567890abcdef12345678');
    expect(encoded.startsWith(SELECTORS.getEntitlement)).toBe(true);
    expect(encoded).toHaveLength(8 + 64 + 64);
  });

  it('encodeGetProduct produces selector + bytes32', () => {
    const encoded = encodeGetProduct('cc'.repeat(32));
    expect(encoded.startsWith(SELECTORS.getProduct)).toBe(true);
    expect(encoded).toHaveLength(8 + 64);
  });

  it('handles 0x prefix on product ID', () => {
    const withPrefix = encodeGetProduct('0x' + 'dd'.repeat(32));
    const withoutPrefix = encodeGetProduct('dd'.repeat(32));
    expect(withPrefix).toBe(withoutPrefix);
  });

  it('handles 0x prefix on address', () => {
    const with0x = encodeIsEntitled('aa'.repeat(32), '0x' + 'bb'.repeat(20));
    const without0x = encodeIsEntitled('aa'.repeat(32), 'bb'.repeat(20));
    expect(with0x).toBe(without0x);
  });

  it('short product ID is zero-padded left', () => {
    const encoded = encodeGetProduct('abcd');
    const productSlot = encoded.substring(8, 72);
    expect(productSlot).toBe('0'.repeat(60) + 'abcd');
  });
});

describe('decodeBool', () => {
  it('decodes true (non-zero)', () => {
    expect(decodeBool(slot('1'))).toBe(true);
    expect(decodeBool(slot('ff'))).toBe(true);
  });

  it('decodes false (zero)', () => {
    expect(decodeBool(slot('0'))).toBe(false);
  });

  it('handles 0x prefix', () => {
    expect(decodeBool('0x' + slot('1'))).toBe(true);
  });

  it('returns false for short data', () => {
    expect(decodeBool('0x')).toBe(false);
    expect(decodeBool('')).toBe(false);
  });
});

describe('decodeGetEntitlement', () => {
  it('decodes a full entitlement tuple', () => {
    const productId = 'ab'.repeat(32);
    const user = '0'.repeat(24) + 'ff'.repeat(20); // address in slot
    const sourceIdStr = 'sub_stripe_123';
    const sourceIdHex = strToHex(sourceIdStr);

    // Build ABI-encoded tuple
    // Outer: offset to tuple data = 0x20 (32)
    const outerOffset = uint(32);

    // Tuple fields (order matters):
    // 0: productId (bytes32)
    // 1: user (address)
    // 2: grantedAt (uint64)
    // 3: expiresAt (int64)
    // 4: autoRenew (bool)
    // 5: source (uint8 as uint256)
    // 6: sourceId offset (dynamic)
    // 7: active (bool)
    // 8: revokedAt (uint64)
    // 9: revokedBy (address)
    // 10: exists (bool)
    const tupleFields = [
      productId,                            // productId
      user,                                 // user
      uint(1700000000),                     // grantedAt
      uint(1900000000),                     // expiresAt
      uint(1),                              // autoRenew = true
      uint(5),                              // source = 5 (stripe)
      uint(11 * 32),                        // sourceId offset = 11 slots = 352 bytes
      uint(1),                              // active = true
      uint(0),                              // revokedAt = 0
      '0'.repeat(64),                       // revokedBy = zero address
      uint(1),                              // exists = true
    ].join('');

    // Dynamic string at offset 352 bytes (within tuple)
    const strLen = uint(sourceIdStr.length);
    const strData = sourceIdHex.padEnd(64, '0'); // pad to slot boundary

    const data = '0x' + outerOffset + tupleFields + strLen + strData;
    const ent = decodeGetEntitlement(data);

    expect(ent.productId).toBe(productId);
    expect(ent.user).toBe('0x' + 'ff'.repeat(20));
    expect(ent.grantedAt).toBe(1700000000);
    expect(ent.expiresAt).toBe(1900000000);
    expect(ent.autoRenew).toBe(true);
    expect(ent.source).toBe(5);
    expect(ent.sourceId).toBe(sourceIdStr);
    expect(ent.active).toBe(true);
    expect(ent.revokedAt).toBe(0);
    expect(ent.exists).toBe(true);
  });
});

describe('decodeGetProduct', () => {
  it('decodes a full product tuple', () => {
    const creator = '0'.repeat(24) + 'aa'.repeat(20);
    const productId = 'bb'.repeat(32);
    const nameStr = 'Pro Plan';
    const uriStr = 'https://example.com/meta.json';

    // Tuple: creator, productId, name_offset, uri_offset, createdAt, updatedAt,
    //        active, frozen, entitlementCount, delegateCount, defaultDuration, exists
    // 12 slots = 384 bytes for fixed fields

    const outerOffset = uint(32);
    const tupleFields = [
      creator,              // creator
      productId,            // productId
      uint(12 * 32),        // name offset = 384 bytes
      uint(0),              // metadataUri offset (placeholder - computed below)
      uint(1700000000),     // createdAt
      uint(1700100000),     // updatedAt
      uint(1),              // active
      uint(0),              // frozen
      uint(42),             // entitlementCount
      uint(3),              // delegateCount
      uint(2592000),        // defaultDuration (30 days)
      uint(1),              // exists
    ];

    // Compute offsets: name is at slot 12 (byte 384)
    // name string: 1 slot for length + ceil(nameStr.length/32) slots for data = 384 + 64 + ...
    const nameLen = nameStr.length;
    const namePaddedSlots = Math.ceil(nameLen / 32);
    const nameBlockSize = 32 + namePaddedSlots * 32; // length slot + data

    const uriOffset = 12 * 32 + nameBlockSize;
    tupleFields[3] = uint(uriOffset); // update uri offset

    const nameSlot = uint(nameLen) + strToHex(nameStr).padEnd(namePaddedSlots * 64, '0');
    const uriSlot = uint(uriStr.length) + strToHex(uriStr).padEnd(Math.ceil(uriStr.length / 32) * 64, '0');

    const data = '0x' + outerOffset + tupleFields.join('') + nameSlot + uriSlot;
    const product = decodeGetProduct(data);

    expect(product.creator).toBe('0x' + 'aa'.repeat(20));
    expect(product.productId).toBe(productId);
    expect(product.name).toBe(nameStr);
    expect(product.metadataUri).toBe(uriStr);
    expect(product.createdAt).toBe(1700000000);
    expect(product.active).toBe(true);
    expect(product.frozen).toBe(false);
    expect(product.entitlementCount).toBe(42);
    expect(product.delegateCount).toBe(3);
    expect(product.defaultDuration).toBe(2592000);
    expect(product.exists).toBe(true);
  });
});

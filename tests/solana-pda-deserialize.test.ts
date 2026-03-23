/**
 * E2E: Solana PDA derivation, product deserialization, entitlement
 * deserialization, base58 edge cases, findProgramAddress bump search.
 */
import { describe, it, expect } from 'vitest';
import {
  base58Decode,
  base58Encode,
  hexToBytes,
  bytesToHex,
  findProgramAddress,
  deriveEntitlementAddress,
  deriveProductAddress,
  deriveProductIdHex,
  deserializeSolanaEntitlement as deserializeEntitlement,
  deserializeSolanaProduct as deserializeProduct,
} from '@doubloon/checker-mobile';
import { deriveProductIdHex as coreDeriveProductIdHex } from '@doubloon/core';

describe('findProgramAddress', () => {
  it('derives deterministic PDA from seeds', () => {
    const programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const seeds = [new TextEncoder().encode('test-seed')];

    const [addr, bump] = findProgramAddress(seeds, programId);
    expect(addr).toBeTruthy();
    expect(typeof addr).toBe('string');
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);

    // Deterministic
    const [addr2, bump2] = findProgramAddress(seeds, programId);
    expect(addr2).toBe(addr);
    expect(bump2).toBe(bump);
  });

  it('different seeds produce different PDAs', () => {
    const programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const [addr1] = findProgramAddress([new TextEncoder().encode('seed-a')], programId);
    const [addr2] = findProgramAddress([new TextEncoder().encode('seed-b')], programId);
    expect(addr1).not.toBe(addr2);
  });

  it('multi-seed PDA derivation', () => {
    const programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const [addr] = findProgramAddress(
      [
        new TextEncoder().encode('entitlement'),
        hexToBytes('ab'.repeat(32)),
        hexToBytes('cd'.repeat(32)),
      ],
      programId,
    );
    expect(addr).toBeTruthy();
  });
});

describe('deriveEntitlementAddress', () => {
  it('produces a valid base58 address', () => {
    const productIdHex = deriveProductIdHex('pro-monthly');
    // Use a known Solana program ID
    const programId = '11111111111111111111111111111111';
    const userWallet = base58Encode(new Uint8Array(32).fill(1));

    const addr = deriveEntitlementAddress(productIdHex, userWallet, programId);
    expect(typeof addr).toBe('string');
    expect(addr.length).toBeGreaterThan(20);
  });

  it('different users produce different addresses', () => {
    const productIdHex = deriveProductIdHex('pro-monthly');
    const programId = '11111111111111111111111111111111';
    const user1 = base58Encode(new Uint8Array(32).fill(1));
    const user2 = base58Encode(new Uint8Array(32).fill(2));

    const addr1 = deriveEntitlementAddress(productIdHex, user1, programId);
    const addr2 = deriveEntitlementAddress(productIdHex, user2, programId);
    expect(addr1).not.toBe(addr2);
  });
});

describe('deriveProductAddress', () => {
  it('produces a valid base58 address', () => {
    const productIdHex = deriveProductIdHex('pro-monthly');
    const programId = '11111111111111111111111111111111';

    const addr = deriveProductAddress(productIdHex, programId);
    expect(typeof addr).toBe('string');
    expect(addr.length).toBeGreaterThan(20);
  });
});

describe('base58 advanced edge cases', () => {
  it('empty bytes encodes to empty string', () => {
    expect(base58Encode(new Uint8Array(0))).toBe('');
  });

  it('multiple leading zeros', () => {
    const bytes = new Uint8Array([0, 0, 0, 1]);
    const encoded = base58Encode(bytes);
    expect(encoded.startsWith('111')).toBe(true); // 3 leading 1s
    expect(base58Decode(encoded)).toEqual(bytes);
  });

  it('max single byte (255)', () => {
    const bytes = new Uint8Array([255]);
    const encoded = base58Encode(bytes);
    const decoded = base58Decode(encoded);
    expect(decoded).toEqual(bytes);
  });

  it('invalid char throws', () => {
    expect(() => base58Decode('0OIl')).toThrow(); // 0, O, I, l are invalid
  });

  it('round-trip random-like 32-byte values', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 7 + 13) & 0xff;
    const encoded = base58Encode(bytes);
    expect(base58Decode(encoded)).toEqual(bytes);
  });
});

describe('hex edge cases', () => {
  it('empty hex → empty bytes', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('single byte', () => {
    expect(hexToBytes('ff')).toEqual(new Uint8Array([255]));
    expect(bytesToHex(new Uint8Array([255]))).toBe('ff');
  });

  it('preserves leading zeros', () => {
    expect(bytesToHex(new Uint8Array([0, 0, 1]))).toBe('000001');
  });
});

describe('deserializeProduct (mobile)', () => {
  function buildProductBuffer(opts: {
    creator: Uint8Array;
    productId: string;
    name: string;
    metadataUri: string;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    frozen: boolean;
    entitlementCount: number;
    delegateCount: number;
    defaultDuration: number;
  }): Uint8Array {
    const nameBytes = new TextEncoder().encode(opts.name);
    const uriBytes = new TextEncoder().encode(opts.metadataUri);
    const pidBytes = hexToBytes(opts.productId);

    const size = 8 + 32 + 32 + 4 + nameBytes.length + 4 + uriBytes.length + 8 + 8 + 1 + 1 + 8 + 4 + 8;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    let offset = 8; // skip discriminator

    buf.set(opts.creator, offset); offset += 32;
    buf.set(pidBytes, offset); offset += 32;

    view.setUint32(offset, nameBytes.length, true); offset += 4;
    buf.set(nameBytes, offset); offset += nameBytes.length;

    view.setUint32(offset, uriBytes.length, true); offset += 4;
    buf.set(uriBytes, offset); offset += uriBytes.length;

    // createdAt, updatedAt as i64
    view.setBigInt64(offset, BigInt(opts.createdAt), true); offset += 8;
    view.setBigInt64(offset, BigInt(opts.updatedAt), true); offset += 8;

    buf[offset] = opts.active ? 1 : 0; offset += 1;
    buf[offset] = opts.frozen ? 1 : 0; offset += 1;

    // entitlementCount u64
    view.setBigUint64(offset, BigInt(opts.entitlementCount), true); offset += 8;
    // delegateCount u32
    view.setUint32(offset, opts.delegateCount, true); offset += 4;
    // defaultDuration i64
    view.setBigInt64(offset, BigInt(opts.defaultDuration), true); offset += 8;

    return buf;
  }

  it('deserializes product with all fields', () => {
    const productId = 'ab'.repeat(32);
    const data = buildProductBuffer({
      creator: new Uint8Array(32).fill(1),
      productId,
      name: 'Pro Monthly',
      metadataUri: 'https://example.com/meta.json',
      createdAt: 1700000000,
      updatedAt: 1700100000,
      active: true,
      frozen: false,
      entitlementCount: 42,
      delegateCount: 3,
      defaultDuration: 2592000,
    });

    const product = deserializeProduct(data);
    expect(product.productId).toBe(productId);
    expect(product.name).toBe('Pro Monthly');
    expect(product.metadataUri).toBe('https://example.com/meta.json');
    expect(product.active).toBe(true);
    expect(product.frozen).toBe(false);
    expect(product.entitlementCount).toBe(42);
    expect(product.delegateCount).toBe(3);
    expect(product.defaultDuration).toBe(2592000);
    expect(product.createdAt).toEqual(new Date(1700000000 * 1000));
  });

  it('deserializes frozen inactive product', () => {
    const data = buildProductBuffer({
      creator: new Uint8Array(32).fill(1),
      productId: 'cc'.repeat(32),
      name: 'Frozen',
      metadataUri: '',
      createdAt: 1700000000,
      updatedAt: 1700000000,
      active: false,
      frozen: true,
      entitlementCount: 0,
      delegateCount: 0,
      defaultDuration: 0,
    });

    const product = deserializeProduct(data);
    expect(product.active).toBe(false);
    expect(product.frozen).toBe(true);
    expect(product.metadataUri).toBe('');
  });
});

describe('deserializeEntitlement (mobile) — additional cases', () => {
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
    const pidBytes = hexToBytes(opts.productId);
    const size = 8 + 32 + 32 + 8 + 8 + 1 + 1 + 4 + sourceIdBytes.length + 1 + 8 + 32;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    let offset = 8;

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

  it('all 7 source types round-trip', () => {
    const sourceNames = ['platform', 'creator', 'delegate', 'apple', 'google', 'stripe', 'x402'];
    for (let i = 0; i <= 6; i++) {
      const data = buildEntitlementBuffer({
        productId: 'aa'.repeat(32),
        user: new Uint8Array(32).fill(1),
        grantedAt: 1700000000,
        expiresAt: 0,
        autoRenew: false,
        source: i,
        sourceId: `src_${i}`,
        active: true,
        revokedAt: 0,
        revokedBy: new Uint8Array(32),
      });

      const ent = deserializeEntitlement(data);
      expect(ent.source).toBe(sourceNames[i]);
    }
  });

  it('unknown source falls back to platform', () => {
    const data = buildEntitlementBuffer({
      productId: 'aa'.repeat(32),
      user: new Uint8Array(32).fill(1),
      grantedAt: 1700000000,
      expiresAt: 0,
      autoRenew: false,
      source: 99, // unmapped
      sourceId: 'test',
      active: true,
      revokedAt: 0,
      revokedBy: new Uint8Array(32),
    });

    const ent = deserializeEntitlement(data);
    expect(ent.source).toBe('platform'); // fallback
  });

  it('non-default revokedBy is preserved', () => {
    const revokedByKey = new Uint8Array(32).fill(42);
    const data = buildEntitlementBuffer({
      productId: 'aa'.repeat(32),
      user: new Uint8Array(32).fill(1),
      grantedAt: 1700000000,
      expiresAt: 1800000000,
      autoRenew: false,
      source: 5,
      sourceId: 'sub_1',
      active: false,
      revokedAt: 1750000000,
      revokedBy: revokedByKey,
    });

    const ent = deserializeEntitlement(data);
    expect(ent.revokedBy).not.toBeNull();
    expect(ent.revokedAt).toEqual(new Date(1750000000 * 1000));
  });

  it('default revokedBy (all zeros) becomes null', () => {
    const data = buildEntitlementBuffer({
      productId: 'aa'.repeat(32),
      user: new Uint8Array(32).fill(1),
      grantedAt: 1700000000,
      expiresAt: 0,
      autoRenew: false,
      source: 0,
      sourceId: '',
      active: true,
      revokedAt: 0,
      revokedBy: new Uint8Array(32), // all zeros
    });

    const ent = deserializeEntitlement(data);
    expect(ent.revokedBy).toBeNull();
    expect(ent.revokedAt).toBeNull();
  });

  it('empty sourceId string', () => {
    const data = buildEntitlementBuffer({
      productId: 'aa'.repeat(32),
      user: new Uint8Array(32).fill(1),
      grantedAt: 1700000000,
      expiresAt: 0,
      autoRenew: false,
      source: 0,
      sourceId: '',
      active: true,
      revokedAt: 0,
      revokedBy: new Uint8Array(32),
    });

    const ent = deserializeEntitlement(data);
    expect(ent.sourceId).toBe('');
  });
});

describe('deriveProductIdHex mobile ↔ core parity (extended)', () => {
  const slugs = [
    'pro-monthly', 'pro-yearly', 'lifetime-pass',
    'team-enterprise', 'starter-plan', 'api-access',
    'premium-support', 'basic-tier',
  ];

  for (const slug of slugs) {
    it(`${slug} matches core`, () => {
      expect(deriveProductIdHex(slug)).toBe(coreDeriveProductIdHex(slug));
    });
  }

  it('produces 64-char hex string', () => {
    const id = deriveProductIdHex('any-slug');
    expect(id).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(id)).toBe(true);
  });
});

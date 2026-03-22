import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { DoubloonSolanaReader, type CacheAdapter } from '../src/reader.js';

// ---------------------------------------------------------------------------
// Mock @solana/web3.js Connection
// ---------------------------------------------------------------------------

const mockGetAccountInfo = vi.fn();
const mockGetMultipleAccountsInfo = vi.fn();
const mockGetProgramAccounts = vi.fn();

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getAccountInfo: mockGetAccountInfo,
      getMultipleAccountsInfo: mockGetMultipleAccountsInfo,
      getProgramAccounts: mockGetProgramAccounts,
    })),
  };
});

// ---------------------------------------------------------------------------
// Helpers to build mock account data buffers (same layout as deserialize.ts)
// ---------------------------------------------------------------------------

const DISC = 8;
const DEFAULT_PUBKEY = new PublicKey('11111111111111111111111111111111');

function writePubkey(buf: Buffer, offset: number, pk: PublicKey): void {
  pk.toBuffer().copy(buf, offset);
}

function writeString(buf: Buffer, offset: number, str: string): number {
  const encoded = Buffer.from(str, 'utf-8');
  buf.writeUInt32LE(encoded.length, offset);
  encoded.copy(buf, offset + 4);
  return 4 + encoded.length;
}

function buildEntitlementBuffer(opts: {
  productId: Buffer;
  user: PublicKey;
  grantedAt: bigint;
  expiresAt: bigint;
  autoRenew: boolean;
  source: number;
  sourceId: string;
  active: boolean;
  revokedAt: bigint;
  revokedBy: PublicKey;
}): Buffer {
  const size = DISC + 32 + 32 + 8 + 8 + 1 + 1 + (4 + 256) + 1 + 8 + 32;
  const buf = Buffer.alloc(size);
  let offset = DISC;

  opts.productId.copy(buf, offset); offset += 32;
  writePubkey(buf, offset, opts.user); offset += 32;
  buf.writeBigInt64LE(opts.grantedAt, offset); offset += 8;
  buf.writeBigInt64LE(opts.expiresAt, offset); offset += 8;
  buf[offset] = opts.autoRenew ? 1 : 0; offset += 1;
  buf[offset] = opts.source; offset += 1;
  offset += writeString(buf, offset, opts.sourceId);
  buf[offset] = opts.active ? 1 : 0; offset += 1;
  buf.writeBigInt64LE(opts.revokedAt, offset); offset += 8;
  writePubkey(buf, offset, opts.revokedBy); offset += 32;

  return buf.subarray(0, offset);
}

function makeActiveEntitlementBuf(user: PublicKey, productIdHex: string): Buffer {
  const futureTs = BigInt(Math.floor(Date.now() / 1000) + 86400);
  return buildEntitlementBuffer({
    productId: Buffer.from(productIdHex, 'hex'),
    user,
    grantedAt: 1700000000n,
    expiresAt: futureTs,
    autoRenew: true,
    source: 0,
    sourceId: 'txn_test',
    active: true,
    revokedAt: 0n,
    revokedBy: DEFAULT_PUBKEY,
  });
}

// Use a deterministic program ID for tests
const PROGRAM_ID = '11111111111111111111111111111111';
const PRODUCT_ID_HEX = 'ab'.repeat(32);

function createReader(cache?: CacheAdapter): DoubloonSolanaReader {
  return new DoubloonSolanaReader({
    rpcUrl: 'https://fake-rpc.test',
    programId: PROGRAM_ID,
    cache,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DoubloonSolanaReader', () => {
  describe('checkEntitlement', () => {
    it('returns not_found when getAccountInfo returns null', async () => {
      mockGetAccountInfo.mockResolvedValueOnce(null);

      const reader = createReader();
      const user = PublicKey.unique().toBase58();
      const result = await reader.checkEntitlement(PRODUCT_ID_HEX, user);

      expect(result.entitled).toBe(false);
      expect(result.reason).toBe('not_found');
      expect(result.entitlement).toBeNull();
      expect(mockGetAccountInfo).toHaveBeenCalledTimes(1);
    });

    it('returns active when valid active entitlement data is returned', async () => {
      const user = PublicKey.unique();
      const accountData = makeActiveEntitlementBuf(user, PRODUCT_ID_HEX);

      mockGetAccountInfo.mockResolvedValueOnce({
        data: accountData,
        executable: false,
        lamports: 1_000_000,
        owner: new PublicKey(PROGRAM_ID),
      });

      const reader = createReader();
      const result = await reader.checkEntitlement(PRODUCT_ID_HEX, user.toBase58());

      expect(result.entitled).toBe(true);
      expect(result.reason).toBe('active');
      expect(result.entitlement).not.toBeNull();
      expect(result.entitlement!.user).toBe(user.toBase58());
    });

    it('returns expired when entitlement has past expiry', async () => {
      const user = PublicKey.unique();
      const pastTs = BigInt(Math.floor(Date.now() / 1000) - 86400);
      const accountData = buildEntitlementBuffer({
        productId: Buffer.from(PRODUCT_ID_HEX, 'hex'),
        user,
        grantedAt: 1700000000n,
        expiresAt: pastTs,
        autoRenew: false,
        source: 0,
        sourceId: '',
        active: true,
        revokedAt: 0n,
        revokedBy: DEFAULT_PUBKEY,
      });

      mockGetAccountInfo.mockResolvedValueOnce({
        data: accountData,
        executable: false,
        lamports: 1_000_000,
        owner: new PublicKey(PROGRAM_ID),
      });

      const reader = createReader();
      const result = await reader.checkEntitlement(PRODUCT_ID_HEX, user.toBase58());

      expect(result.entitled).toBe(false);
      expect(result.reason).toBe('expired');
    });

    it('returns revoked when entitlement is inactive', async () => {
      const user = PublicKey.unique();
      const futureTs = BigInt(Math.floor(Date.now() / 1000) + 86400);
      const accountData = buildEntitlementBuffer({
        productId: Buffer.from(PRODUCT_ID_HEX, 'hex'),
        user,
        grantedAt: 1700000000n,
        expiresAt: futureTs,
        autoRenew: false,
        source: 0,
        sourceId: '',
        active: false,
        revokedAt: 1700050000n,
        revokedBy: PublicKey.unique(),
      });

      mockGetAccountInfo.mockResolvedValueOnce({
        data: accountData,
        executable: false,
        lamports: 1_000_000,
        owner: new PublicKey(PROGRAM_ID),
      });

      const reader = createReader();
      const result = await reader.checkEntitlement(PRODUCT_ID_HEX, user.toBase58());

      expect(result.entitled).toBe(false);
      expect(result.reason).toBe('revoked');
    });
  });

  describe('checkEntitlements (batch)', () => {
    it('uses getMultipleAccountsInfo and returns results keyed by productId', async () => {
      const user = PublicKey.unique();
      const productA = 'aa'.repeat(32);
      const productB = 'bb'.repeat(32);

      const bufA = makeActiveEntitlementBuf(user, productA);

      // productB returns null (not found)
      mockGetMultipleAccountsInfo.mockResolvedValueOnce([
        { data: bufA, executable: false, lamports: 1_000_000, owner: new PublicKey(PROGRAM_ID) },
        null,
      ]);

      const reader = createReader();
      const batch = await reader.checkEntitlements([productA, productB], user.toBase58());

      expect(mockGetMultipleAccountsInfo).toHaveBeenCalledTimes(1);
      expect(batch.user).toBe(user.toBase58());
      expect(batch.results[productA].entitled).toBe(true);
      expect(batch.results[productA].reason).toBe('active');
      expect(batch.results[productB].entitled).toBe(false);
      expect(batch.results[productB].reason).toBe('not_found');
    });
  });

  describe('cache integration', () => {
    it('first call hits RPC and populates cache, second call returns cached', async () => {
      const store = new Map<string, unknown>();

      const mockCache: CacheAdapter = {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set: vi.fn(async (key: string, value: unknown, _ttlMs: number) => {
          store.set(key, value);
        }),
        invalidate: vi.fn(async () => {}),
        invalidatePrefix: vi.fn(async () => {}),
      };

      const user = PublicKey.unique();
      const accountData = makeActiveEntitlementBuf(user, PRODUCT_ID_HEX);

      mockGetAccountInfo.mockResolvedValue({
        data: accountData,
        executable: false,
        lamports: 1_000_000,
        owner: new PublicKey(PROGRAM_ID),
      });

      const reader = createReader(mockCache);

      // First call — should miss cache, hit RPC, then set cache
      const result1 = await reader.checkEntitlement(PRODUCT_ID_HEX, user.toBase58());
      expect(result1.entitled).toBe(true);
      expect(mockGetAccountInfo).toHaveBeenCalledTimes(1);
      expect(mockCache.get).toHaveBeenCalledTimes(1);
      expect(mockCache.set).toHaveBeenCalledTimes(1);

      // Second call — should hit cache, NOT call RPC again
      const result2 = await reader.checkEntitlement(PRODUCT_ID_HEX, user.toBase58());
      expect(result2.entitled).toBe(true);
      expect(mockGetAccountInfo).toHaveBeenCalledTimes(1); // still 1 — no additional RPC call
      expect(mockCache.get).toHaveBeenCalledTimes(2);
    });

    it('bypasses cache when no cache adapter provided', async () => {
      const user = PublicKey.unique();
      mockGetAccountInfo.mockResolvedValue(null);

      const reader = createReader(); // no cache
      await reader.checkEntitlement(PRODUCT_ID_HEX, user.toBase58());
      await reader.checkEntitlement(PRODUCT_ID_HEX, user.toBase58());

      // Without cache, both calls hit RPC
      expect(mockGetAccountInfo).toHaveBeenCalledTimes(2);
    });
  });

  describe('getEntitlement', () => {
    it('returns null when account not found', async () => {
      mockGetAccountInfo.mockResolvedValueOnce(null);
      const reader = createReader();
      const result = await reader.getEntitlement(PRODUCT_ID_HEX, PublicKey.unique().toBase58());
      expect(result).toBeNull();
    });

    it('returns deserialized entitlement when account exists', async () => {
      const user = PublicKey.unique();
      const buf = makeActiveEntitlementBuf(user, PRODUCT_ID_HEX);

      mockGetAccountInfo.mockResolvedValueOnce({
        data: buf,
        executable: false,
        lamports: 1_000_000,
        owner: new PublicKey(PROGRAM_ID),
      });

      const reader = createReader();
      const ent = await reader.getEntitlement(PRODUCT_ID_HEX, user.toBase58());

      expect(ent).not.toBeNull();
      expect(ent!.user).toBe(user.toBase58());
      expect(ent!.productId).toBe(PRODUCT_ID_HEX);
    });
  });
});

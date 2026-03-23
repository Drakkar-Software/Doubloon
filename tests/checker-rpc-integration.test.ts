/**
 * E2E: MobileSolanaChecker and MobileEvmChecker with mocked fetch.
 * Tests the full checker flow: PDA derivation → RPC call → deserialize → checkEntitlement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MobileSolanaChecker,
  MobileEvmChecker,
  hexToBytes,
  bytesToHex,
  deriveProductIdHex,
  SELECTORS,
} from '@doubloon/checker-mobile';

function strToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function slot(hex: string): string { return hex.padStart(64, '0'); }
function uint(n: number | bigint): string { return BigInt(n).toString(16).padStart(64, '0'); }

/** Build a base64-encoded Solana entitlement account buffer */
function buildSolanaEntitlementBase64(opts: {
  productId: string; user: Uint8Array;
  grantedAt: number; expiresAt: number;
  active: boolean; source: number; sourceId: string;
}): string {
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
  buf[offset] = 0; offset += 1; // autoRenew
  buf[offset] = opts.source; offset += 1;
  view.setUint32(offset, sourceIdBytes.length, true); offset += 4;
  buf.set(sourceIdBytes, offset); offset += sourceIdBytes.length;
  buf[offset] = opts.active ? 1 : 0; offset += 1;
  view.setBigInt64(offset, BigInt(0), true); offset += 8; // revokedAt
  buf.set(new Uint8Array(32), offset); // revokedBy (default)

  // Convert to base64 using Buffer (Node.js)
  return Buffer.from(buf).toString('base64');
}

describe('MobileSolanaChecker with mocked RPC', () => {
  let originalFetch: typeof globalThis.fetch;
  const programId = '11111111111111111111111111111111';
  const productId = deriveProductIdHex('pro-monthly');

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('getEntitlement returns null when account not found', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: null } }),
    }) as any;

    const checker = new MobileSolanaChecker({ rpcUrl: 'https://rpc.test', programId });
    const ent = await checker.getEntitlement(productId, '11111111111111111111111111111111');
    expect(ent).toBeNull();
  });

  it('getEntitlement deserializes account data', async () => {
    const userKey = new Uint8Array(32).fill(1);
    const base64Data = buildSolanaEntitlementBase64({
      productId, user: userKey,
      grantedAt: 1700000000, expiresAt: 1800000000,
      active: true, source: 5, sourceId: 'sub_stripe_1',
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        jsonrpc: '2.0', id: 1,
        result: {
          value: {
            data: [base64Data, 'base64'],
            executable: false, lamports: 1000000, owner: programId,
          },
        },
      }),
    }) as any;

    const checker = new MobileSolanaChecker({ rpcUrl: 'https://rpc.test', programId });
    const wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi'; // some base58
    const ent = await checker.getEntitlement(productId, wallet);

    expect(ent).not.toBeNull();
    expect(ent!.productId).toBe(productId);
    expect(ent!.active).toBe(true);
    expect(ent!.source).toBe('stripe');
    expect(ent!.sourceId).toBe('sub_stripe_1');
    expect(ent!.grantedAt).toEqual(new Date(1700000000 * 1000));
    expect(ent!.expiresAt).toEqual(new Date(1800000000 * 1000));
  });

  it('checkEntitlement returns entitled=true for active entitlement', async () => {
    const base64Data = buildSolanaEntitlementBase64({
      productId, user: new Uint8Array(32).fill(1),
      grantedAt: 1700000000,
      expiresAt: Math.floor(Date.now() / 1000) + 86400, // expires tomorrow
      active: true, source: 0, sourceId: 'test',
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        jsonrpc: '2.0', id: 1,
        result: { value: { data: [base64Data, 'base64'], executable: false, lamports: 1, owner: programId } },
      }),
    }) as any;

    const checker = new MobileSolanaChecker({ rpcUrl: 'https://rpc.test', programId });
    const check = await checker.checkEntitlement(productId, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi');

    expect(check.entitled).toBe(true);
    expect(check.entitlement).not.toBeNull();
  });

  it('checkEntitlement returns entitled=false when no account', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: null } }),
    }) as any;

    const checker = new MobileSolanaChecker({ rpcUrl: 'https://rpc.test', programId });
    const check = await checker.checkEntitlement(productId, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi');

    expect(check.entitled).toBe(false);
    expect(check.entitlement).toBeNull();
  });

  it('checkEntitlements empty array → empty results', async () => {
    const checker = new MobileSolanaChecker({ rpcUrl: 'https://rpc.test', programId });
    const batch = await checker.checkEntitlements([], 'wallet');
    expect(batch.results).toEqual({});
    expect(batch.user).toBe('wallet');
  });

  it('checkEntitlements batch: mix of found and not found', async () => {
    const pid1 = deriveProductIdHex('product-1');
    const pid2 = deriveProductIdHex('product-2');

    const base64Data = buildSolanaEntitlementBase64({
      productId: pid1, user: new Uint8Array(32).fill(1),
      grantedAt: 1700000000, expiresAt: Math.floor(Date.now() / 1000) + 86400,
      active: true, source: 0, sourceId: 'test',
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        jsonrpc: '2.0', id: 1,
        result: {
          value: [
            { data: [base64Data, 'base64'], executable: false, lamports: 1, owner: programId },
            null, // pid2 not found
          ],
        },
      }),
    }) as any;

    const checker = new MobileSolanaChecker({ rpcUrl: 'https://rpc.test', programId });
    const walletBase58 = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
    const batch = await checker.checkEntitlements([pid1, pid2], walletBase58);

    expect(batch.results[pid1].entitled).toBe(true);
    expect(batch.results[pid2].entitled).toBe(false);
    expect(batch.user).toBe(walletBase58);
  });

  it('RPC error propagates through checker', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 502, statusText: 'Bad Gateway',
      json: async () => ({}),
    }) as any;

    const checker = new MobileSolanaChecker({ rpcUrl: 'https://rpc.test', programId });
    await expect(checker.getEntitlement(productId, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi')).rejects.toMatchObject({
      code: 'RPC_ERROR',
    });
  });
});

describe('MobileEvmChecker with mocked RPC', () => {
  let originalFetch: typeof globalThis.fetch;
  const contractAddress = '0x1234567890abcdef1234567890abcdef12345678';

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function makeEntitlementABI(opts: {
    productId: string; user: string;
    grantedAt: number; expiresAt: number;
    active: boolean; source: number; sourceId: string; exists: boolean;
  }): string {
    const sourceIdStr = opts.sourceId;
    const sourceIdHex = strToHex(sourceIdStr);
    const outerOffset = uint(32);
    const tupleFields = [
      opts.productId.padStart(64, '0'),
      '0'.repeat(24) + opts.user.replace('0x', ''),
      uint(opts.grantedAt),
      uint(opts.expiresAt),
      uint(0), // autoRenew
      uint(opts.source),
      uint(11 * 32), // sourceId offset
      uint(opts.active ? 1 : 0),
      uint(0), // revokedAt
      '0'.repeat(64), // revokedBy
      uint(opts.exists ? 1 : 0),
    ].join('');
    const strLen = uint(sourceIdStr.length);
    const strData = sourceIdHex.padEnd(64, '0');
    return '0x' + outerOffset + tupleFields + strLen + strData;
  }

  it('isEntitled returns true when contract says true', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        jsonrpc: '2.0', id: 1,
        result: '0x' + uint(1), // true
      }),
    }) as any;

    const checker = new MobileEvmChecker({ rpcUrl: 'https://eth.test', contractAddress });
    const entitled = await checker.isEntitled('aa'.repeat(32), '0x' + 'bb'.repeat(20));
    expect(entitled).toBe(true);
  });

  it('isEntitled returns false for zero result', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + uint(0) }),
    }) as any;

    const checker = new MobileEvmChecker({ rpcUrl: 'https://eth.test', contractAddress });
    expect(await checker.isEntitled('aa'.repeat(32), '0x' + 'bb'.repeat(20))).toBe(false);
  });

  it('getEntitlement returns null for empty result (0x)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }),
    }) as any;

    const checker = new MobileEvmChecker({ rpcUrl: 'https://eth.test', contractAddress });
    const ent = await checker.getEntitlement('aa'.repeat(32), '0x' + 'bb'.repeat(20));
    expect(ent).toBeNull();
  });

  it('getEntitlement returns null when exists=false', async () => {
    const abiData = makeEntitlementABI({
      productId: 'aa'.repeat(32), user: '0x' + 'bb'.repeat(20),
      grantedAt: 1700000000, expiresAt: 1800000000,
      active: true, source: 0, sourceId: 'test', exists: false,
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: abiData }),
    }) as any;

    const checker = new MobileEvmChecker({ rpcUrl: 'https://eth.test', contractAddress });
    const ent = await checker.getEntitlement('aa'.repeat(32), '0x' + 'bb'.repeat(20));
    expect(ent).toBeNull();
  });

  it('getEntitlement decodes full ABI result', async () => {
    const productId = 'cc'.repeat(32);
    const user = '0x' + 'dd'.repeat(20);
    const abiData = makeEntitlementABI({
      productId, user,
      grantedAt: 1700000000,
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      active: true, source: 5, sourceId: 'sub_stripe_x', exists: true,
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: abiData }),
    }) as any;

    const checker = new MobileEvmChecker({ rpcUrl: 'https://eth.test', contractAddress });
    const ent = await checker.getEntitlement(productId, user);

    expect(ent).not.toBeNull();
    expect(ent!.productId).toBe(productId);
    expect(ent!.active).toBe(true);
    expect(ent!.source).toBe('stripe');
    expect(ent!.sourceId).toBe('sub_stripe_x');
  });

  it('checkEntitlements empty → empty batch', async () => {
    const checker = new MobileEvmChecker({ rpcUrl: 'https://eth.test', contractAddress });
    const batch = await checker.checkEntitlements([], '0xwallet');
    expect(batch.results).toEqual({});
    expect(batch.user).toBe('0xwallet');
  });

  it('checkEntitlements parallel calls for each product', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }), // empty → null
    });
    globalThis.fetch = fetchMock as any;

    const checker = new MobileEvmChecker({ rpcUrl: 'https://eth.test', contractAddress });
    const batch = await checker.checkEntitlements(['p1', 'p2', 'p3'], '0xwallet');

    // Should have made 3 separate eth_call requests (parallel)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(batch.results['p1'].entitled).toBe(false);
    expect(batch.results['p2'].entitled).toBe(false);
    expect(batch.results['p3'].entitled).toBe(false);
  });

  it('ethCall sends correct data format', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + uint(1) }),
    });
    globalThis.fetch = fetchMock as any;

    const checker = new MobileEvmChecker({ rpcUrl: 'https://eth.test', contractAddress });
    await checker.isEntitled('aa'.repeat(32), '0x' + 'bb'.repeat(20));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.method).toBe('eth_call');
    expect(body.params[0].to).toBe(contractAddress);
    expect(body.params[0].data).toMatch(/^0x/);
    expect(body.params[1]).toBe('latest');
  });
});

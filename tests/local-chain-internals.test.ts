/**
 * E2E: Local chain internals — signer counter, writer error paths,
 * reader isEntitled/getPlatform, tx hash format, store key generation.
 */
import { describe, it, expect, vi } from 'vitest';
import { createLocalChain, LocalChainStore, LocalChainWriter, LocalChainReader } from '@doubloon/chain-local';
import { deriveProductIdHex, DoubloonError } from '@doubloon/core';
import type { Logger } from '@doubloon/core';

describe('LocalChainSigner', () => {
  it('produces incrementing signatures', async () => {
    const { signer } = createLocalChain();
    const sig1 = await signer.signAndSend('tx1');
    const sig2 = await signer.signAndSend('tx2');
    const sig3 = await signer.signAndSend('tx3');

    expect(sig1).toBe('local-sig-00000001');
    expect(sig2).toBe('local-sig-00000002');
    expect(sig3).toBe('local-sig-00000003');
  });

  it('default publicKey is "local-signer"', () => {
    const { signer } = createLocalChain();
    expect(signer.publicKey).toBe('local-signer');
  });

  it('logs debug on signAndSend', async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { LocalChainSigner } = await import('@doubloon/chain-local');
    const signer = new LocalChainSigner({ logger });

    await signer.signAndSend({ test: true });
    expect(logger.debug).toHaveBeenCalledWith('signAndSend', expect.objectContaining({ sig: 'local-sig-00000001' }));
  });
});

describe('LocalChainStore key generation', () => {
  it('entitlementKey uses null separator', () => {
    const key = LocalChainStore.entitlementKey('prod-123', 'user-456');
    expect(key).toBe('prod-123\0user-456');
  });

  it('delegateKey uses null separator with delegate marker', () => {
    const key = LocalChainStore.delegateKey('prod-123', 'delegate-789');
    expect(key).toBe('prod-123\0delegate\0delegate-789');
  });

  it('different keys for different users', () => {
    const k1 = LocalChainStore.entitlementKey('p', 'u1');
    const k2 = LocalChainStore.entitlementKey('p', 'u2');
    expect(k1).not.toBe(k2);
  });
});

describe('LocalChainStore tx hash', () => {
  it('tx hashes increment and have correct format', () => {
    const store = new LocalChainStore();
    const r1 = store.mintEntitlement({ productId: 'p', user: 'u1', expiresAt: null, source: 'platform', sourceId: 's1' });
    const r2 = store.mintEntitlement({ productId: 'p', user: 'u2', expiresAt: null, source: 'platform', sourceId: 's2' });

    expect(r1.txHash).toMatch(/^0xlocal[0-9a-f]{60}$/);
    expect(r2.txHash).toMatch(/^0xlocal[0-9a-f]{60}$/);
    expect(r1.txHash).not.toBe(r2.txHash);
  });

  it('revoke returns tx hash', () => {
    const store = new LocalChainStore();
    store.mintEntitlement({ productId: 'p', user: 'u', expiresAt: null, source: 'platform', sourceId: 's' });
    const result = store.revokeEntitlement({ productId: 'p', user: 'u', revokedBy: 'admin' });

    expect(result).not.toBeNull();
    expect(result!.txHash).toMatch(/^0xlocal/);
  });

  it('revoke non-existent returns null', () => {
    const store = new LocalChainStore();
    const result = store.revokeEntitlement({ productId: 'p', user: 'u', revokedBy: 'admin' });
    expect(result).toBeNull();
  });
});

describe('LocalChainStore mint preserves grantedAt on re-mint', () => {
  it('first mint sets grantedAt, re-mint preserves it', () => {
    const store = new LocalChainStore();
    const r1 = store.mintEntitlement({
      productId: 'p', user: 'u', expiresAt: null, source: 'stripe', sourceId: 's1',
    });
    const grantedAt1 = r1.entitlement.grantedAt;

    // Wait a tick for different timestamp
    const r2 = store.mintEntitlement({
      productId: 'p', user: 'u', expiresAt: new Date(Date.now() + 86400_000),
      source: 'stripe', sourceId: 's2',
    });

    expect(r2.entitlement.grantedAt).toEqual(grantedAt1); // preserved
    expect(r2.entitlement.sourceId).toBe('s2'); // updated
  });
});

describe('LocalChainStore entitlement count accuracy', () => {
  it('increments only for new entitlements, not re-mints', () => {
    const store = new LocalChainStore();
    const pid = deriveProductIdHex('count-test');
    store.registerProduct({ productId: pid, name: 'P', metadataUri: '', defaultDuration: 0, creator: '0x' });

    store.mintEntitlement({ productId: pid, user: 'u1', expiresAt: null, source: 'platform', sourceId: '1' });
    expect(store.getProduct(pid)!.entitlementCount).toBe(1);

    // Re-mint same user — count should NOT increment
    store.mintEntitlement({ productId: pid, user: 'u1', expiresAt: null, source: 'platform', sourceId: '2' });
    expect(store.getProduct(pid)!.entitlementCount).toBe(1);

    // New user — count increments
    store.mintEntitlement({ productId: pid, user: 'u2', expiresAt: null, source: 'platform', sourceId: '3' });
    expect(store.getProduct(pid)!.entitlementCount).toBe(2);
  });
});

describe('LocalChainWriter error paths', () => {
  it('platform frozen → PRODUCT_FROZEN', async () => {
    const store = new LocalChainStore({ frozen: true });
    const writer = new LocalChainWriter({ store });

    await expect(writer.mintEntitlement({
      productId: 'p', user: 'u', expiresAt: null, source: 'platform', sourceId: 's',
      signer: 'admin',
    })).rejects.toMatchObject({ code: 'PRODUCT_FROZEN', message: expect.stringContaining('frozen') });
  });

  it('inactive product → PRODUCT_NOT_ACTIVE', async () => {
    const store = new LocalChainStore();
    store.registerProduct({ productId: 'p', name: 'P', metadataUri: '', defaultDuration: 0, creator: '0x' });
    store.setProductActive('p', false);
    const writer = new LocalChainWriter({ store });

    await expect(writer.mintEntitlement({
      productId: 'p', user: 'u', expiresAt: null, source: 'platform', sourceId: 's',
      signer: 'admin',
    })).rejects.toMatchObject({ code: 'PRODUCT_NOT_ACTIVE' });
  });

  it('frozen product → PRODUCT_FROZEN', async () => {
    const store = new LocalChainStore();
    store.registerProduct({ productId: 'p', name: 'P', metadataUri: '', defaultDuration: 0, creator: '0x' });
    store.setProductFrozen('p', true);
    const writer = new LocalChainWriter({ store });

    await expect(writer.mintEntitlement({
      productId: 'p', user: 'u', expiresAt: null, source: 'platform', sourceId: 's',
      signer: 'admin',
    })).rejects.toMatchObject({ code: 'PRODUCT_FROZEN' });
  });

  it('revoke non-existent → ACCOUNT_NOT_FOUND', async () => {
    const store = new LocalChainStore();
    const writer = new LocalChainWriter({ store });

    await expect(writer.revokeEntitlement({
      productId: 'p', user: 'u', reason: 'test', signer: 'admin',
    })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('mint without registered product succeeds (no product check if product is null)', async () => {
    const store = new LocalChainStore();
    const writer = new LocalChainWriter({ store });

    // Product not registered — writer allows mint (product check is null guard)
    const result = await writer.mintEntitlement({
      productId: 'p', user: 'u', expiresAt: null, source: 'platform', sourceId: 's',
      signer: 'admin',
    });
    expect(result.hash).toBeTruthy();
  });

  it('writer logs on mint and revoke', async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = new LocalChainStore();
    const writer = new LocalChainWriter({ store, logger });

    await writer.mintEntitlement({
      productId: 'p', user: 'u', expiresAt: null, source: 'stripe', sourceId: 's',
      signer: 'admin',
    });
    expect(logger.info).toHaveBeenCalledWith('mintEntitlement', expect.objectContaining({ productId: 'p' }));

    await writer.revokeEntitlement({ productId: 'p', user: 'u', reason: 'test', signer: 'admin' });
    expect(logger.info).toHaveBeenCalledWith('revokeEntitlement', expect.objectContaining({ productId: 'p' }));
  });

  it('registerProduct returns hash', async () => {
    const store = new LocalChainStore();
    const writer = new LocalChainWriter({ store });

    const result = await writer.registerProduct({
      productId: 'p', name: 'P', metadataUri: '', defaultDuration: 0, signer: 'admin',
    });
    expect(result.hash).toMatch(/^0xlocal-register-/);
  });
});

describe('LocalChainReader', () => {
  it('isEntitled returns boolean', async () => {
    const local = createLocalChain();
    const pid = deriveProductIdHex('reader-test');

    expect(await local.reader.isEntitled(pid, '0xAlice')).toBe(false);

    local.store.mintEntitlement({ productId: pid, user: '0xAlice', expiresAt: null, source: 'platform', sourceId: 's' });
    expect(await local.reader.isEntitled(pid, '0xAlice')).toBe(true);
  });

  it('getPlatform returns platform state', async () => {
    const local = createLocalChain();
    const platform = await local.reader.getPlatform();
    expect(platform.authority).toBe('local-authority');
    expect(platform.productCount).toBe(0);
    expect(platform.frozen).toBe(false);
  });

  it('getProduct returns product or null', async () => {
    const local = createLocalChain();
    const pid = deriveProductIdHex('get-prod');

    expect(await local.reader.getProduct(pid)).toBeNull();

    local.store.registerProduct({ productId: pid, name: 'P', metadataUri: 'uri', defaultDuration: 86400, creator: '0x' });
    const product = await local.reader.getProduct(pid);
    expect(product).not.toBeNull();
    expect(product!.name).toBe('P');
    expect(product!.metadataUri).toBe('uri');
    expect(product!.defaultDuration).toBe(86400);
  });

  it('getUserEntitlements returns all for user', async () => {
    const local = createLocalChain();
    const p1 = deriveProductIdHex('multi-1');
    const p2 = deriveProductIdHex('multi-2');

    local.store.mintEntitlement({ productId: p1, user: '0xA', expiresAt: null, source: 'platform', sourceId: 's1' });
    local.store.mintEntitlement({ productId: p2, user: '0xA', expiresAt: null, source: 'stripe', sourceId: 's2' });
    local.store.mintEntitlement({ productId: p1, user: '0xB', expiresAt: null, source: 'platform', sourceId: 's3' });

    const aEnts = await local.reader.getUserEntitlements('0xA');
    expect(aEnts).toHaveLength(2);

    const bEnts = await local.reader.getUserEntitlements('0xB');
    expect(bEnts).toHaveLength(1);

    const cEnts = await local.reader.getUserEntitlements('0xNobody');
    expect(cEnts).toHaveLength(0);
  });

  it('reader logs debug calls', async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = new LocalChainStore();
    const { LocalChainReader } = await import('@doubloon/chain-local');
    const reader = new LocalChainReader({ store, logger });

    await reader.checkEntitlement('p', 'u');
    expect(logger.debug).toHaveBeenCalledWith('checkEntitlement', expect.any(Object));

    await reader.getEntitlement('p', 'u');
    expect(logger.debug).toHaveBeenCalledWith('getEntitlement', expect.any(Object));

    await reader.getUserEntitlements('u');
    expect(logger.debug).toHaveBeenCalledWith('getUserEntitlements', expect.any(Object));
  });

  it('checkEntitlements sets user field', async () => {
    const local = createLocalChain();
    const batch = await local.reader.checkEntitlements(['p1', 'p2'], '0xAlice');
    expect(batch.user).toBe('0xAlice');
  });
});

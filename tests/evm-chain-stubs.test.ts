/**
 * E2E: EVM chain stubs — reader, writer, and NFT client all throw
 * informative RPC_ERROR, verifying error codes, messages, and logging.
 */
import { describe, it, expect, vi } from 'vitest';
import { DoubloonEvmReader } from '@doubloon/evm';
import { DoubloonEvmWriter } from '@doubloon/evm';
import { DoubloonNFTClient } from '@doubloon/evm';
import { DoubloonError } from '@doubloon/core';
import type { Logger } from '@doubloon/core';

const defaultConfig = {
  rpcUrl: 'https://eth.test.rpc',
  contractAddress: '0x1234567890abcdef1234567890abcdef12345678',
  chainId: 1,
};

describe('DoubloonEvmReader', () => {
  const methods = [
    ['isEntitled', ['pid', 'addr']],
    ['getEntitlement', ['pid', 'addr']],
    ['checkEntitlement', ['pid', 'addr']],
    ['checkEntitlements', [['pid1', 'pid2'], 'addr']],
    ['getProduct', ['pid']],
  ] as const;

  for (const [method, args] of methods) {
    it(`${method} throws RPC_ERROR with helpful message`, async () => {
      const reader = new DoubloonEvmReader(defaultConfig);
      await expect((reader as any)[method](...args)).rejects.toMatchObject({
        code: 'RPC_ERROR',
        message: expect.stringContaining('viem'),
      });
    });
  }

  it('logs debug before throwing', async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reader = new DoubloonEvmReader({ ...defaultConfig, logger });

    try { await reader.isEntitled('pid', 'addr'); } catch {}
    expect(logger.debug).toHaveBeenCalledWith('isEntitled check', expect.any(Object));

    try { await reader.getEntitlement('pid', 'addr'); } catch {}
    expect(logger.debug).toHaveBeenCalledWith('getEntitlement', expect.any(Object));

    try { await reader.getProduct('pid'); } catch {}
    expect(logger.debug).toHaveBeenCalledWith('getProduct', expect.any(Object));
  });
});

describe('DoubloonEvmWriter', () => {
  const methods = [
    ['registerProduct', [{ productId: 'p', name: 'N', metadataUri: '', defaultDuration: 0 }]],
    ['mintEntitlement', [{ productId: 'p', user: 'u', expiresAt: null, source: 'stripe', sourceId: 's' }]],
    ['revokeEntitlement', [{ productId: 'p', user: 'u', reason: 'r' }]],
  ] as const;

  for (const [method, args] of methods) {
    it(`${method} throws RPC_ERROR`, async () => {
      const writer = new DoubloonEvmWriter(defaultConfig);
      await expect((writer as any)[method](...args)).rejects.toMatchObject({
        code: 'RPC_ERROR',
        message: expect.stringContaining('wallet client'),
      });
    });
  }

  it('logs info before throwing', async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const writer = new DoubloonEvmWriter({ ...defaultConfig, logger });

    try { await writer.mintEntitlement({ productId: 'p', user: 'u', expiresAt: null, source: 'stripe', sourceId: 's' } as any); } catch {}
    expect(logger.info).toHaveBeenCalledWith('Building mintEntitlement tx', expect.any(Object));
  });
});

describe('DoubloonNFTClient', () => {
  const methods = [
    ['computeTokenId', ['pid', 'addr'], 'keccak256'],
    ['getExpiration', ['tokenId'], 'RPC client'],
    ['isRenewable', ['tokenId'], 'RPC client'],
    ['mintSubscriptionNFT', [{ productId: 'p', user: 'u', expiration: new Date(), renewable: true }], 'wallet client'],
    ['renewSubscription', [{ tokenId: 't', durationSeconds: 3600 }], 'wallet client'],
  ] as const;

  for (const [method, args, msgFragment] of methods) {
    it(`${method} throws RPC_ERROR mentioning ${msgFragment}`, async () => {
      const client = new DoubloonNFTClient(defaultConfig);
      // computeTokenId is sync (not async)
      if (method === 'computeTokenId') {
        expect(() => (client as any)[method](...args)).toThrow(msgFragment);
      } else {
        await expect((client as any)[method](...args)).rejects.toMatchObject({
          code: 'RPC_ERROR',
          message: expect.stringContaining(msgFragment),
        });
      }
    });
  }

  it('all errors are DoubloonError instances', async () => {
    const client = new DoubloonNFTClient(defaultConfig);
    try {
      await client.getExpiration('token-1');
    } catch (err) {
      expect(err).toBeInstanceOf(DoubloonError);
      expect((err as DoubloonError).code).toBe('RPC_ERROR');
    }
  });
});

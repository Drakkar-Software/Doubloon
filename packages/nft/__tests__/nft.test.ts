import { describe, it, expect } from 'vitest';
import { DoubloonNFTClient } from '../src/erc5643.js';

describe('DoubloonNFTClient', () => {
  const client = new DoubloonNFTClient({
    contractAddress: '0x0000000000000000000000000000000000000001',
    rpcUrl: 'http://localhost:8545',
    chainId: 8453,
  });

  it('constructs without error', () => {
    expect(client).toBeDefined();
  });

  it('getExpiration throws RPC_ERROR without configured client', async () => {
    await expect(client.getExpiration('0x123')).rejects.toThrow(
      'NFT client requires a configured RPC client',
    );
  });

  it('isRenewable throws RPC_ERROR without configured client', async () => {
    await expect(client.isRenewable('0x123')).rejects.toThrow(
      'NFT client requires a configured RPC client',
    );
  });

  it('mintSubscriptionNFT throws RPC_ERROR without configured client', async () => {
    await expect(
      client.mintSubscriptionNFT({
        productId: 'a'.repeat(64),
        user: '0x1234567890abcdef1234567890abcdef12345678',
        expiration: new Date('2025-01-01'),
        renewable: true,
      }),
    ).rejects.toThrow('NFT client requires a configured wallet client');
  });

  it('computeTokenId throws without viem', () => {
    expect(() =>
      client.computeTokenId('a'.repeat(64), '0x1234567890abcdef1234567890abcdef12345678'),
    ).toThrow('NFT client requires viem');
  });
});

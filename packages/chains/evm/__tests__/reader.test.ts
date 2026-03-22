import { describe, it, expect } from 'vitest';
import { DoubloonEvmReader } from '../src/reader.js';

describe('DoubloonEvmReader', () => {
  const reader = new DoubloonEvmReader({
    rpcUrl: 'http://localhost:8545',
    contractAddress: '0x0000000000000000000000000000000000000001',
    chainId: 8453,
  });

  it('checkEntitlement throws RPC_ERROR without configured client', async () => {
    await expect(
      reader.checkEntitlement('a'.repeat(64), '0x1234567890abcdef1234567890abcdef12345678'),
    ).rejects.toThrow('EVM reader requires a configured RPC client');
  });

  it('getProduct throws RPC_ERROR without configured client', async () => {
    await expect(reader.getProduct('a'.repeat(64))).rejects.toThrow(
      'EVM reader requires a configured RPC client',
    );
  });

  it('isEntitled throws RPC_ERROR without configured client', async () => {
    await expect(
      reader.isEntitled('a'.repeat(64), '0x1234567890abcdef1234567890abcdef12345678'),
    ).rejects.toThrow('EVM reader requires a configured RPC client');
  });

  it('getEntitlement throws RPC_ERROR without configured client', async () => {
    await expect(
      reader.getEntitlement('a'.repeat(64), '0x1234567890abcdef1234567890abcdef12345678'),
    ).rejects.toThrow('EVM reader requires a configured RPC client');
  });
});

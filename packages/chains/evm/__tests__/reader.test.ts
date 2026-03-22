import { describe, it, expect } from 'vitest';
import { DoubloonEvmReader } from '../src/reader.js';

describe('DoubloonEvmReader', () => {
  const reader = new DoubloonEvmReader({
    rpcUrl: 'http://localhost:8545',
    contractAddress: '0x0000000000000000000000000000000000000001',
    chainId: 8453,
  });

  it('checkEntitlement returns not_found for non-existent', async () => {
    const result = await reader.checkEntitlement('a'.repeat(64), '0x1234567890abcdef1234567890abcdef12345678');
    expect(result.entitled).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('getProduct returns null for non-existent', async () => {
    const result = await reader.getProduct('a'.repeat(64));
    expect(result).toBeNull();
  });
});

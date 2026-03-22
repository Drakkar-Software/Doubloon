import type {
  Entitlement, EntitlementCheck, EntitlementSource, Product, Logger, Platform,
} from '@doubloon/core';
import { checkEntitlement, DoubloonError, nullLogger } from '@doubloon/core';
import { DoubloonAbi } from './abi.js';

const SOURCE_MAP: Record<number, EntitlementSource> = {
  0: 'platform', 1: 'creator', 2: 'delegate',
  3: 'apple', 4: 'google', 5: 'stripe', 6: 'x402',
};

export interface DoubloonEvmReaderConfig {
  rpcUrl: string;
  contractAddress: string;
  chainId: number;
  cacheTtlMs?: number;
  logger?: Logger;
}

export class DoubloonEvmReader {
  private contractAddress: string;
  private rpcUrl: string;
  private logger: Logger;

  constructor(config: DoubloonEvmReaderConfig) {
    this.contractAddress = config.contractAddress;
    this.rpcUrl = config.rpcUrl;
    this.logger = config.logger ?? nullLogger;
  }

  async isEntitled(productId: string, userAddress: string): Promise<boolean> {
    // In production, uses viem's readContract
    // For now, placeholder that would be connected to an actual RPC
    this.logger.debug('isEntitled check', { productId, userAddress });
    return false;
  }

  async getEntitlement(productId: string, userAddress: string): Promise<Entitlement | null> {
    this.logger.debug('getEntitlement', { productId, userAddress });
    return null;
  }

  async checkEntitlement(productId: string, userAddress: string): Promise<EntitlementCheck> {
    const entitlement = await this.getEntitlement(productId, userAddress);
    return checkEntitlement(entitlement);
  }

  async getProduct(productId: string): Promise<Product | null> {
    this.logger.debug('getProduct', { productId });
    return null;
  }
}

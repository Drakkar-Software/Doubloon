import type { Logger } from '@doubloon/core';
import { DoubloonError, nullLogger } from '@doubloon/core';

export interface DoubloonNFTConfig {
  contractAddress: string;
  rpcUrl: string;
  chainId: number;
  logger?: Logger;
}

export class DoubloonNFTClient {
  private contractAddress: string;
  private rpcUrl: string;
  private chainId: number;
  private logger: Logger;

  constructor(config: DoubloonNFTConfig) {
    this.contractAddress = config.contractAddress;
    this.rpcUrl = config.rpcUrl;
    this.chainId = config.chainId;
    this.logger = config.logger ?? nullLogger;
  }

  computeTokenId(productId: string, userAddress: string): string {
    this.logger.debug('computeTokenId', { productId, userAddress });
    throw new DoubloonError(
      'RPC_ERROR',
      'NFT client requires viem for keccak256. Install viem and configure a PublicClient.',
    );
  }

  async getExpiration(tokenId: string): Promise<Date | null> {
    this.logger.debug('getExpiration', { tokenId });
    throw new DoubloonError(
      'RPC_ERROR',
      'NFT client requires a configured RPC client. Install viem and pass a PublicClient.',
    );
  }

  async isRenewable(tokenId: string): Promise<boolean> {
    this.logger.debug('isRenewable', { tokenId });
    throw new DoubloonError(
      'RPC_ERROR',
      'NFT client requires a configured RPC client. Install viem and pass a PublicClient.',
    );
  }

  async mintSubscriptionNFT(params: {
    productId: string;
    user: string;
    expiration: Date;
    renewable: boolean;
  }): Promise<{ hash: string }> {
    this.logger.info('mintSubscriptionNFT', params);
    throw new DoubloonError(
      'RPC_ERROR',
      'NFT client requires a configured wallet client. Install viem and use createWalletClient.',
    );
  }

  async renewSubscription(params: {
    tokenId: string;
    durationSeconds: number;
  }): Promise<{ hash: string }> {
    this.logger.info('renewSubscription', params);
    throw new DoubloonError(
      'RPC_ERROR',
      'NFT client requires a configured wallet client. Install viem and use createWalletClient.',
    );
  }
}

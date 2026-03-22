import type { MintInstruction, RevokeInstruction, EntitlementSource, Logger } from '@doubloon/core';
import { DoubloonError, nullLogger } from '@doubloon/core';

export interface DoubloonEvmWriterConfig {
  rpcUrl: string;
  contractAddress: string;
  chainId: number;
  logger?: Logger;
}

function entitlementSourceToU8(source: EntitlementSource): number {
  const map: Record<EntitlementSource, number> = {
    platform: 0, creator: 1, delegate: 2,
    apple: 3, google: 4, stripe: 5, x402: 6,
  };
  return map[source];
}

/** Requires a configured viem WalletClient for live transactions. */
export class DoubloonEvmWriter {
  private contractAddress: string;
  private logger: Logger;

  constructor(config: DoubloonEvmWriterConfig) {
    this.contractAddress = config.contractAddress;
    this.logger = config.logger ?? nullLogger;
  }

  /**
   * Registers a new product on-chain.
   * Requires a configured viem WalletClient.
   */
  async registerProduct(params: {
    productId: string;
    name: string;
    metadataUri: string;
    defaultDuration: number;
  }): Promise<{ hash: string }> {
    this.logger.info('Building registerProduct tx', { productId: params.productId });
    throw new DoubloonError(
      'RPC_ERROR',
      'EVM writer requires a configured wallet client. Install viem and use createWalletClient.',
    );
  }

  /**
   * Mints an entitlement for a user.
   * Requires a configured viem WalletClient.
   */
  async mintEntitlement(params: MintInstruction & {
    autoRenew?: boolean;
  }): Promise<{ hash: string }> {
    this.logger.info('Building mintEntitlement tx', {
      productId: params.productId,
      user: params.user,
    });
    throw new DoubloonError(
      'RPC_ERROR',
      'EVM writer requires a configured wallet client. Install viem and use createWalletClient.',
    );
  }

  /**
   * Revokes an existing entitlement.
   * Requires a configured viem WalletClient.
   */
  async revokeEntitlement(params: RevokeInstruction): Promise<{ hash: string }> {
    this.logger.info('Building revokeEntitlement tx', {
      productId: params.productId,
      user: params.user,
    });
    throw new DoubloonError(
      'RPC_ERROR',
      'EVM writer requires a configured wallet client. Install viem and use createWalletClient.',
    );
  }
}

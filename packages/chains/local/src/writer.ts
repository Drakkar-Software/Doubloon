import type { MintInstruction, RevokeInstruction, Logger } from '@doubloon/core';
import { DoubloonError, nullLogger } from '@doubloon/core';
import type { LocalChainStore } from './store.js';

export interface LocalChainWriterConfig {
  store: LocalChainStore;
  logger?: Logger;
}

/**
 * In-memory chain writer that persists entitlements to a LocalChainStore.
 * Implements the ChainWriter interface expected by the Doubloon server.
 */
export class LocalChainWriter {
  readonly #store: LocalChainStore;
  readonly #logger: Logger;

  constructor(config: LocalChainWriterConfig) {
    this.#store = config.store;
    this.#logger = config.logger ?? nullLogger;
  }

  async mintEntitlement(
    params: MintInstruction & { signer: string; autoRenew?: boolean },
  ): Promise<{ hash: string }> {
    this.#logger.info('mintEntitlement', {
      productId: params.productId,
      user: params.user,
      source: params.source,
    });

    const platform = this.#store.getPlatform();
    if (platform.frozen) {
      throw new DoubloonError('PRODUCT_FROZEN', 'Platform is frozen, minting is disabled');
    }

    const product = this.#store.getProduct(params.productId);
    if (product && !product.active) {
      throw new DoubloonError('PRODUCT_NOT_ACTIVE', `Product ${params.productId} is not active`);
    }
    if (product?.frozen) {
      throw new DoubloonError('PRODUCT_FROZEN', `Product ${params.productId} is frozen`);
    }

    const result = this.#store.mintEntitlement({
      productId: params.productId,
      user: params.user,
      expiresAt: params.expiresAt,
      source: params.source,
      sourceId: params.sourceId,
      autoRenew: params.autoRenew,
    });

    return { hash: result.txHash };
  }

  async revokeEntitlement(
    params: RevokeInstruction & { signer: string },
  ): Promise<{ hash: string }> {
    this.#logger.info('revokeEntitlement', {
      productId: params.productId,
      user: params.user,
      reason: params.reason,
    });

    const result = this.#store.revokeEntitlement({
      productId: params.productId,
      user: params.user,
      revokedBy: params.signer,
    });

    if (!result) {
      throw new DoubloonError(
        'ACCOUNT_NOT_FOUND',
        `No entitlement found for product ${params.productId} and user ${params.user}`,
      );
    }

    return { hash: result.txHash };
  }

  async registerProduct(params: {
    productId: string;
    name: string;
    metadataUri: string;
    defaultDuration: number;
    signer: string;
  }): Promise<{ hash: string }> {
    this.#logger.info('registerProduct', { productId: params.productId });

    this.#store.registerProduct({
      productId: params.productId,
      name: params.name,
      metadataUri: params.metadataUri,
      defaultDuration: params.defaultDuration,
      creator: params.signer,
    });

    return { hash: `0xlocal-register-${params.productId.slice(0, 8)}` };
  }
}

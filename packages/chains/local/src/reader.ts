import type {
  Entitlement,
  EntitlementCheck,
  EntitlementCheckBatch,
  Product,
  Platform,
  Logger,
} from '@doubloon/core';
import { checkEntitlement, checkEntitlements, nullLogger } from '@doubloon/core';
import type { LocalChainStore } from './store.js';

export interface LocalChainReaderConfig {
  store: LocalChainStore;
  logger?: Logger;
}

/**
 * In-memory chain reader that reads entitlements and products from a LocalChainStore.
 * Drop-in replacement for DoubloonEvmReader or DoubloonSolanaReader in test/dev environments.
 */
export class LocalChainReader {
  readonly #store: LocalChainStore;
  readonly #logger: Logger;

  constructor(config: LocalChainReaderConfig) {
    this.#store = config.store;
    this.#logger = config.logger ?? nullLogger;
  }

  async checkEntitlement(productId: string, wallet: string): Promise<EntitlementCheck> {
    this.#logger.debug('checkEntitlement', { productId, wallet });
    const entitlement = this.#store.getEntitlement(productId, wallet);
    return checkEntitlement(entitlement);
  }

  async checkEntitlements(productIds: string[], wallet: string): Promise<EntitlementCheckBatch> {
    this.#logger.debug('checkEntitlements', { productIds, wallet });
    const entitlements: Record<string, Entitlement | null> = {};
    for (const productId of productIds) {
      entitlements[productId] = this.#store.getEntitlement(productId, wallet);
    }
    const batch = checkEntitlements(entitlements);
    batch.user = wallet;
    return batch;
  }

  async isEntitled(productId: string, wallet: string): Promise<boolean> {
    const check = await this.checkEntitlement(productId, wallet);
    return check.entitled;
  }

  async getEntitlement(productId: string, wallet: string): Promise<Entitlement | null> {
    this.#logger.debug('getEntitlement', { productId, wallet });
    return this.#store.getEntitlement(productId, wallet);
  }

  async getProduct(productId: string): Promise<Product | null> {
    this.#logger.debug('getProduct', { productId });
    return this.#store.getProduct(productId);
  }

  async getPlatform(): Promise<Platform> {
    return this.#store.getPlatform();
  }

  async getUserEntitlements(wallet: string): Promise<Entitlement[]> {
    this.#logger.debug('getUserEntitlements', { wallet });
    return this.#store.getUserEntitlements(wallet);
  }
}

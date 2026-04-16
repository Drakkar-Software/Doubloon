import type { ChainReader, EntitlementCheck, EntitlementCheckBatch, Entitlement, Product, Logger } from '@doubloon/core';
import { checkEntitlement, checkEntitlements, DoubloonError, nullLogger } from '@doubloon/core';
import type { StarfishClient } from '@drakkar.software/starfish-client';
import { StarfishHttpError, pullEntitlements } from '@drakkar.software/starfish-client';
import type { ProductRegistry } from './product-registry.js';

export interface StarfishReaderConfig {
  client: StarfishClient;
  registry: ProductRegistry;
  /**
   * Storage path template. `{user}` is replaced with the wallet address.
   * Default: `"users/{user}/entitlements"`
   * The reader prepends `/pull/` to form the HTTP path.
   */
  storagePath?: string;
  /** Field in document data holding feature slugs. Default: `"features"` */
  field?: string;
  logger?: Logger;
}

/**
 * Reads entitlements from a Starfish server.
 *
 * Implements ChainReader using Starfish's pull protocol. Entitlements are stored
 * as feature slug arrays: `{ features: ["pro-monthly", "lifetime"] }`.
 *
 * NOTE: Starfish documents have no per-feature expiry timestamp. All present features
 * synthesize as lifetime entitlements (expiresAt: null). Expiry enforcement requires
 * either revocation webhooks or a periodic reconciliation job.
 */
export class StarfishReader implements ChainReader {
  readonly #client: StarfishClient;
  readonly #registry: ProductRegistry;
  readonly #storagePath: string;
  readonly #field: string;
  readonly #logger: Logger;

  constructor(config: StarfishReaderConfig) {
    this.#client = config.client;
    this.#registry = config.registry;
    this.#storagePath = config.storagePath ?? 'users/{user}/entitlements';
    this.#field = config.field ?? 'features';
    this.#logger = config.logger ?? nullLogger;
  }

  async checkEntitlement(productId: string, wallet: string): Promise<EntitlementCheck> {
    this.#logger.debug('StarfishReader.checkEntitlement', { productId, wallet });
    const entitlement = await this.getEntitlement(productId, wallet);
    return checkEntitlement(entitlement);
  }

  async checkEntitlements(productIds: string[], wallet: string): Promise<EntitlementCheckBatch> {
    this.#logger.debug('StarfishReader.checkEntitlements', { productIds, wallet });
    const features = await this.#pullFeatures(wallet);
    const entitlements: Record<string, Entitlement | null> = {};
    for (const productId of productIds) {
      entitlements[productId] = this.#synthesize(productId, wallet, features);
    }
    return checkEntitlements(entitlements, new Date(), wallet);
  }

  async getEntitlement(productId: string, wallet: string): Promise<Entitlement | null> {
    this.#logger.debug('StarfishReader.getEntitlement', { productId, wallet });
    const features = await this.#pullFeatures(wallet);
    return this.#synthesize(productId, wallet, features);
  }

  async getProduct(productId: string): Promise<Product | null> {
    const entry = this.#registry.getEntry(productId);
    if (!entry) return null;
    const now = new Date();
    return {
      creator: 'starfish',
      productId: entry.productId,
      name: entry.name,
      metadataUri: '',
      createdAt: now,
      updatedAt: now,
      active: true,
      frozen: false,
      entitlementCount: 0,
      delegateCount: 0,
      defaultDuration: entry.defaultDuration,
    };
  }

  /** Pull the features array for a wallet. Returns empty Set on 404. */
  async #pullFeatures(wallet: string): Promise<Set<string>> {
    const path = `/pull/${this.#storagePath.replace('{user}', wallet)}`;
    try {
      const list = await pullEntitlements(this.#client, wallet, { path, field: this.#field });
      return new Set(list);
    } catch (err) {
      throw new DoubloonError('RPC_ERROR', `Starfish pull failed: ${String(err)}`, {
        retryable: err instanceof StarfishHttpError ? err.status >= 500 : true,
        chain: 'starfish',
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  #synthesize(productId: string, wallet: string, features: Set<string>): Entitlement | null {
    const entry = this.#registry.getEntry(productId);
    if (!entry) return null;
    if (!features.has(entry.slug)) return null;
    return {
      productId,
      user: wallet,
      grantedAt: new Date(0),
      expiresAt: null,
      autoRenew: false,
      source: 'platform',
      sourceId: 'starfish',
      active: true,
      revokedAt: null,
      revokedBy: null,
    };
  }
}

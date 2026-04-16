import type { MintInstruction, RevokeInstruction, Logger } from '@doubloon/core';
import { DoubloonError, nullLogger } from '@doubloon/core';
import type { StarfishClient } from '@drakkar.software/starfish-client';
import { StarfishHttpError } from '@drakkar.software/starfish-client';
import type { ProductRegistry } from './product-registry.js';

export interface StarfishWriterConfig {
  client: StarfishClient;
  registry: ProductRegistry;
  /**
   * Storage path template. `{user}` is replaced with the wallet address.
   * Default: `"users/{user}/entitlements"`
   */
  storagePath?: string;
  /** Field in document data holding feature slugs. Default: `"features"` */
  field?: string;
  logger?: Logger;
}

/** Opaque transaction returned by the writer, consumed by StarfishSigner. */
export interface StarfishTransaction {
  readonly _type: 'starfish-tx';
  readonly pushPath: string;
  readonly data: Record<string, unknown>;
  readonly baseHash: string | null;
}

/**
 * Prepares Starfish entitlement mutations (pull → modify → return tx).
 *
 * Does NOT execute the push — that is StarfishSigner's responsibility.
 * This split allows mintWithRetry to retry the full pull+push cycle on OCC conflicts.
 */
export class StarfishWriter {
  readonly #client: StarfishClient;
  readonly #registry: ProductRegistry;
  readonly #storagePath: string;
  readonly #field: string;
  readonly #logger: Logger;

  constructor(config: StarfishWriterConfig) {
    this.#client = config.client;
    this.#registry = config.registry;
    this.#storagePath = config.storagePath ?? 'users/{user}/entitlements';
    this.#field = config.field ?? 'features';
    this.#logger = config.logger ?? nullLogger;
  }

  async mintEntitlement(
    params: MintInstruction & { signer: string; autoRenew?: boolean },
  ): Promise<StarfishTransaction> {
    const slug = this.#registry.getSlug(params.productId);
    this.#logger.debug('StarfishWriter.mintEntitlement', { slug, user: params.user });

    const { features, baseHash } = await this.#pullDocument(params.user);
    if (!features.includes(slug)) features.push(slug);

    return {
      _type: 'starfish-tx',
      pushPath: `/push/${this.#storagePath.replace('{user}', params.user)}`,
      data: { [this.#field]: features },
      baseHash,
    };
  }

  async revokeEntitlement(
    params: RevokeInstruction & { signer: string },
  ): Promise<StarfishTransaction> {
    const slug = this.#registry.getSlug(params.productId);
    this.#logger.debug('StarfishWriter.revokeEntitlement', { slug, user: params.user });

    const { features, baseHash } = await this.#pullDocument(params.user);
    const filtered = features.filter((s) => s !== slug);

    return {
      _type: 'starfish-tx',
      pushPath: `/push/${this.#storagePath.replace('{user}', params.user)}`,
      data: { [this.#field]: filtered },
      baseHash,
    };
  }

  async #pullDocument(wallet: string): Promise<{ features: string[]; baseHash: string | null }> {
    const pullPath = `/pull/${this.#storagePath.replace('{user}', wallet)}`;
    try {
      const result = await this.#client.pull(pullPath);
      const list = (result.data as Record<string, unknown>)[this.#field];
      const features = Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
      return { features, baseHash: result.hash };
    } catch (err) {
      if (err instanceof StarfishHttpError && err.status === 404) {
        return { features: [], baseHash: null };
      }
      throw new DoubloonError('RPC_ERROR', `Starfish pull failed: ${String(err)}`, {
        retryable: err instanceof StarfishHttpError ? err.status >= 500 : true,
        chain: 'starfish',
        cause: err instanceof Error ? err : undefined,
      });
    }
  }
}

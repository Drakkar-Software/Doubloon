import type { MintInstruction, RevokeInstruction, Logger } from '@drakkar.software/doubloon-core';
import { nullLogger } from '@drakkar.software/doubloon-core';
import type { ProductRegistry } from './product-registry.js';
import type { AnchorTransaction } from './types.js';

export interface AnchorWriterConfig {
  registry: ProductRegistry;
  /** Table name. Default: `"entitlements"` */
  tableName?: string;
  logger?: Logger;
}

/**
 * Prepares Supabase mutations as opaque AnchorTransaction objects.
 *
 * Does NOT execute the write — that is AnchorSigner's responsibility.
 * This split keeps the writer-signer contract consistent with other destinations.
 */
export class AnchorWriter {
  readonly #registry: ProductRegistry;
  readonly #tableName: string;
  readonly #logger: Logger;

  constructor(config: AnchorWriterConfig) {
    this.#registry = config.registry;
    this.#tableName = config.tableName ?? 'entitlements';
    this.#logger = config.logger ?? nullLogger;
  }

  async mintEntitlement(
    params: MintInstruction & { signer: string; autoRenew?: boolean },
  ): Promise<AnchorTransaction> {
    const slug = this.#registry.getSlug(params.productId);
    this.#logger.debug('AnchorWriter.mintEntitlement', { slug, user: params.user });

    return {
      _type: 'anchor-tx',
      operation: 'upsert',
      table: this.#tableName,
      data: {
        product_id: params.productId,
        user_wallet: params.user,
        slug,
        granted_at: new Date().toISOString(),
        expires_at: params.expiresAt?.toISOString() ?? null,
        auto_renew: params.autoRenew ?? false,
        source: params.source,
        source_id: params.sourceId,
        active: true,
        revoked_at: null,
        revoked_by: null,
      },
      conflictColumns: 'product_id,user_wallet',
    };
  }

  async revokeEntitlement(
    params: RevokeInstruction & { signer: string },
  ): Promise<AnchorTransaction> {
    this.#logger.debug('AnchorWriter.revokeEntitlement', { productId: params.productId, user: params.user });

    return {
      _type: 'anchor-tx',
      operation: 'update',
      table: this.#tableName,
      data: {
        active: false,
        revoked_at: new Date().toISOString(),
        revoked_by: params.reason,
      },
      matchColumns: {
        product_id: params.productId,
        user_wallet: params.user,
      },
    };
  }
}

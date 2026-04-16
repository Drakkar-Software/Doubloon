import type {
  ChainReader,
  Entitlement,
  EntitlementCheck,
  EntitlementCheckBatch,
  EntitlementSource,
  Logger,
  Product,
} from '@drakkar.software/doubloon-core';
import { checkEntitlement, checkEntitlements, DoubloonError, nullLogger } from '@drakkar.software/doubloon-core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProductRegistry } from './product-registry.js';
import type { EntitlementRow } from './types.js';

export interface AnchorReaderConfig {
  supabase: SupabaseClient;
  registry: ProductRegistry;
  /** Table name. Default: `"entitlements"` */
  tableName?: string;
  logger?: Logger;
}

/**
 * Reads entitlements from a Supabase table.
 *
 * Fetches full rows including expiry, source, and revocation data. Passes the
 * mapped Entitlement through core's checkEntitlement() which handles all four
 * check reasons: active, not_found, expired, revoked.
 */
export class AnchorReader implements ChainReader {
  readonly #supabase: SupabaseClient;
  readonly #registry: ProductRegistry;
  readonly #tableName: string;
  readonly #logger: Logger;

  constructor(config: AnchorReaderConfig) {
    this.#supabase = config.supabase;
    this.#registry = config.registry;
    this.#tableName = config.tableName ?? 'entitlements';
    this.#logger = config.logger ?? nullLogger;
  }

  async checkEntitlement(productId: string, wallet: string): Promise<EntitlementCheck> {
    this.#logger.debug('AnchorReader.checkEntitlement', { productId, wallet });
    const entitlement = await this.getEntitlement(productId, wallet);
    return checkEntitlement(entitlement);
  }

  async checkEntitlements(productIds: string[], wallet: string): Promise<EntitlementCheckBatch> {
    this.#logger.debug('AnchorReader.checkEntitlements', { productIds, wallet });

    const { data, error } = await this.#supabase
      .from(this.#tableName)
      .select('*')
      .eq('user_wallet', wallet)
      .in('product_id', productIds);

    if (error) {
      throw new DoubloonError('RPC_ERROR', `Anchor batch read failed: ${error.message}`, {
        chain: 'anchor',
      });
    }

    const rowMap = new Map<string, EntitlementRow>();
    for (const row of data ?? []) {
      rowMap.set(row.product_id as string, row as EntitlementRow);
    }

    const entitlements: Record<string, Entitlement | null> = {};
    for (const productId of productIds) {
      const row = rowMap.get(productId);
      entitlements[productId] = row ? this.#mapRow(row) : null;
    }

    return checkEntitlements(entitlements, new Date(), wallet);
  }

  async getEntitlement(productId: string, wallet: string): Promise<Entitlement | null> {
    this.#logger.debug('AnchorReader.getEntitlement', { productId, wallet });

    const { data, error } = await this.#supabase
      .from(this.#tableName)
      .select('*')
      .eq('product_id', productId)
      .eq('user_wallet', wallet)
      .maybeSingle();

    if (error) {
      throw new DoubloonError('RPC_ERROR', `Anchor read failed: ${error.message}`, {
        chain: 'anchor',
      });
    }

    return data ? this.#mapRow(data as EntitlementRow) : null;
  }

  async getProduct(productId: string): Promise<Product | null> {
    const entry = this.#registry.getEntry(productId);
    if (!entry) return null;
    const now = new Date();
    return {
      creator: 'anchor',
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

  #mapRow(row: EntitlementRow): Entitlement {
    return {
      productId: row.product_id,
      user: row.user_wallet,
      grantedAt: new Date(row.granted_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      autoRenew: row.auto_renew,
      source: row.source as EntitlementSource,
      sourceId: row.source_id,
      active: row.active,
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
      revokedBy: row.revoked_by,
    };
  }
}

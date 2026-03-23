import type { MetadataStore, ProductMetadata } from '@doubloon/storage';
import type { WalletResolver } from '@doubloon/auth';
import type { Store } from '@doubloon/core';

/**
 * Generic SQL query interface compatible with pg.Pool, pg.Client, etc.
 */
export interface PgLike {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface PostgresMetadataStoreConfig {
  pool: PgLike;
  /** Table name for product metadata. Defaults to "doubloon_products" */
  tableName?: string;
  /** Table name for assets. Defaults to "doubloon_assets" */
  assetsTable?: string;
}

/**
 * Postgres-backed MetadataStore for product metadata and assets.
 */
function validateTableName(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(name)) {
    throw new Error(`Invalid table name: "${name}" — must be a valid SQL identifier`);
  }
  return name;
}

export class PostgresMetadataStore implements MetadataStore {
  private pool: PgLike;
  private table: string;
  private assetsTable: string;

  constructor(config: PostgresMetadataStoreConfig) {
    this.pool = config.pool;
    this.table = validateTableName(config.tableName ?? 'doubloon_products');
    this.assetsTable = validateTableName(config.assetsTable ?? 'doubloon_assets');
  }

  async getProduct(productId: string): Promise<ProductMetadata | null> {
    const { rows } = await this.pool.query<{ data: string }>(
      `SELECT data FROM ${this.table} WHERE product_id = $1`,
      [productId],
    );
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].data) as ProductMetadata;
  }

  async putProduct(metadata: ProductMetadata): Promise<{ uri: string }> {
    await this.pool.query(
      `INSERT INTO ${this.table} (product_id, slug, data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (product_id) DO UPDATE SET data = $3, updated_at = NOW()`,
      [metadata.productId, metadata.slug, JSON.stringify(metadata)],
    );
    return { uri: `pg://${this.table}/${metadata.productId}` };
  }

  async deleteProduct(productId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.table} WHERE product_id = $1`,
      [productId],
    );
  }

  async listProducts(opts?: { creator?: string; limit?: number; offset?: number }): Promise<ProductMetadata[]> {
    let query = `SELECT data FROM ${this.table}`;
    const values: unknown[] = [];
    let paramIdx = 1;

    if (opts?.creator) {
      query += ` WHERE data->>'creator' = $${paramIdx++}`;
      values.push(opts.creator);
    }

    query += ` ORDER BY updated_at DESC`;

    if (opts?.limit) {
      query += ` LIMIT $${paramIdx++}`;
      values.push(opts.limit);
    }
    if (opts?.offset) {
      query += ` OFFSET $${paramIdx++}`;
      values.push(opts.offset);
    }

    const { rows } = await this.pool.query<{ data: string }>(query, values);
    return rows.map((r) => JSON.parse(r.data) as ProductMetadata);
  }

  async putAsset(productId: string, name: string, data: Buffer, contentType: string): Promise<{ url: string }> {
    await this.pool.query(
      `INSERT INTO ${this.assetsTable} (product_id, name, data, content_type, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (product_id, name) DO UPDATE SET data = $3, content_type = $4, updated_at = NOW()`,
      [productId, name, data, contentType],
    );
    return { url: `pg://${this.assetsTable}/${productId}/${name}` };
  }

  async getAssetUrl(productId: string, name: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ product_id: string }>(
      `SELECT product_id FROM ${this.assetsTable} WHERE product_id = $1 AND name = $2`,
      [productId, name],
    );
    if (rows.length === 0) return null;
    return `pg://${this.assetsTable}/${productId}/${name}`;
  }
}

export interface PostgresWalletResolverConfig {
  pool: PgLike;
  /** Table name. Defaults to "doubloon_wallets" */
  tableName?: string;
}

/**
 * Postgres-backed WalletResolver for mapping store user IDs to wallet addresses.
 */
export class PostgresWalletResolver implements WalletResolver {
  private pool: PgLike;
  private table: string;

  constructor(config: PostgresWalletResolverConfig) {
    this.pool = config.pool;
    this.table = validateTableName(config.tableName ?? 'doubloon_wallets');
  }

  async resolveWallet(store: Store, storeUserId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ wallet: string }>(
      `SELECT wallet FROM ${this.table} WHERE store = $1 AND store_user_id = $2`,
      [store, storeUserId],
    );
    return rows.length > 0 ? rows[0].wallet : null;
  }

  async linkWallet(store: Store, storeUserId: string, wallet: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (store, store_user_id, wallet, linked_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (store, store_user_id) DO UPDATE SET wallet = $3, linked_at = NOW()`,
      [store, storeUserId, wallet],
    );
  }
}

/**
 * SQL migration for creating the Doubloon Postgres tables.
 */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS doubloon_products (
  product_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS doubloon_assets (
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data BYTEA NOT NULL,
  content_type TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, name)
);

CREATE TABLE IF NOT EXISTS doubloon_wallets (
  store TEXT NOT NULL,
  store_user_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store, store_user_id)
);

CREATE INDEX IF NOT EXISTS idx_doubloon_wallets_wallet ON doubloon_wallets (wallet);
`;

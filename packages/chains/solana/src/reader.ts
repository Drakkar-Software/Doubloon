import { Connection, PublicKey } from '@solana/web3.js';
import {
  type Entitlement,
  type EntitlementCheck,
  type EntitlementCheckBatch,
  type Product,
  type MintDelegate,
  type Platform,
  type Logger,
  checkEntitlement,
  checkEntitlements,
  deriveProductIdHex,
  DoubloonError,
  nullLogger,
} from '@doubloon/core';
import {
  deriveEntitlementPda,
  deriveProductPda,
  deriveDelegatePda,
  derivePlatformPda,
} from './pda.js';
import {
  deserializeEntitlement,
  deserializeProduct,
  deserializeDelegate,
  deserializePlatform,
} from './deserialize.js';

export interface CacheAdapter {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlMs: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  invalidatePrefix(prefix: string): Promise<void>;
}

export interface DoubloonSolanaReaderConfig {
  rpcUrl: string;
  programId: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  cache?: CacheAdapter;
  cacheTtlMs?: number;
  logger?: Logger;
}

/**
 * Solana on-chain reader for Doubloon entitlements and products.
 *
 * Fetches and deserializes on-chain data (products, entitlements, delegates)
 * with optional caching. Implements the EntitlementCheck interface for batch queries.
 *
 * @example
 * const reader = new DoubloonSolanaReader({
 *   rpcUrl: 'https://api.mainnet-beta.solana.com',
 *   programId: 'DubNXFKzDiniBDcCTUzApxvwkd5fuwF8VVZZ6sDj7JJM',
 * });
 * const check = await reader.checkEntitlement(productId, userWallet);
 */
export class DoubloonSolanaReader {
  private connection: Connection;
  private programId: PublicKey;
  private cache?: CacheAdapter;
  private cacheTtlMs: number;
  private logger: Logger;

  constructor(config: DoubloonSolanaReaderConfig) {
    this.connection = new Connection(config.rpcUrl, config.commitment ?? 'confirmed');
    this.programId = new PublicKey(config.programId);
    this.cache = config.cache;
    this.cacheTtlMs = config.cacheTtlMs ?? 30_000;
    this.logger = config.logger ?? nullLogger;
  }

  /**
   * Get the platform singleton state.
   * @throws DoubloonError if platform PDA not found
   * @returns Platform with authority, product count, and frozen flag
   */
  async getPlatform(): Promise<Platform> {
    const [pda] = derivePlatformPda(this.programId);
    const account = await this.fetchAccount(pda, 'platform');
    if (!account) throw new DoubloonError('ACCOUNT_NOT_FOUND', 'Platform not initialized');
    return deserializePlatform(account);
  }

  /**
   * Get a product's on-chain metadata.
   *
   * @param productId - Product ID (32-byte hex string)
   * @returns Product with authority, status, and duration, or null if not found
   */
  async getProduct(productId: string): Promise<Product | null> {
    const [pda] = deriveProductPda(productId, this.programId);
    const account = await this.fetchAccount(pda, `product:${productId}`);
    return account ? deserializeProduct(account) : null;
  }

  /**
   * Get a product by its human-readable slug.
   *
   * @param slug - Product slug (e.g., 'premium-plan')
   * @returns Product metadata, or null if not found
   */
  async getProductBySlug(slug: string): Promise<Product | null> {
    const productId = deriveProductIdHex(slug);
    return this.getProduct(productId);
  }

  /**
   * Get an entitlement for a specific product and user.
   *
   * @param productId - Product ID (32-byte hex string)
   * @param userWallet - User's Solana wallet address
   * @returns Entitlement with active status and expiration, or null if not found
   */
  async getEntitlement(productId: string, userWallet: string): Promise<Entitlement | null> {
    const [pda] = deriveEntitlementPda(productId, userWallet, this.programId);
    const cacheKey = `entitlement:${productId}:${userWallet}`;
    const account = await this.fetchAccount(pda, cacheKey);
    return account ? deserializeEntitlement(account) : null;
  }

  /**
   * Check if a user has access to a product.
   *
   * @param productId - Product ID (32-byte hex string)
   * @param userWallet - User's Solana wallet address
   * @returns EntitlementCheck with entitled flag, reason, and expiration
   */
  async checkEntitlement(productId: string, userWallet: string): Promise<EntitlementCheck> {
    const entitlement = await this.getEntitlement(productId, userWallet);
    return checkEntitlement(entitlement);
  }

  /**
   * Batch check access across multiple products for a user.
   * Fetches all entitlement accounts in a single RPC call for efficiency.
   *
   * @param productIds - Array of product IDs (32-byte hex strings)
   * @param userWallet - User's Solana wallet address
   * @returns EntitlementCheckBatch with results for each product
   */
  async checkEntitlements(
    productIds: string[],
    userWallet: string,
  ): Promise<EntitlementCheckBatch> {
    const pdas = productIds.map(
      (pid) => deriveEntitlementPda(pid, userWallet, this.programId)[0],
    );
    const accounts = await this.connection.getMultipleAccountsInfo(pdas);

    const entitlements: Record<string, Entitlement | null> = {};
    for (let i = 0; i < productIds.length; i++) {
      entitlements[productIds[i]] = accounts[i]
        ? deserializeEntitlement(accounts[i]!.data as Buffer)
        : null;
    }

    return checkEntitlements(entitlements, new Date(), userWallet);
  }

  /**
   * Get all entitlements for a user across all products.
   * Uses Solana getProgramAccounts with a memcmp filter for efficient querying.
   *
   * @param userWallet - User's wallet address (base58)
   * @param opts - Options to filter active entitlements only
   * @returns Array of entitlements, potentially large for active users with many products
   */
  async getUserEntitlements(
    userWallet: string,
    opts?: { activeOnly?: boolean },
  ): Promise<Entitlement[]> {
    const userPubkey = new PublicKey(userWallet);
    const filters = [
      { memcmp: { offset: 40, bytes: userPubkey.toBase58() } },
    ];
    const accounts = await this.connection.getProgramAccounts(this.programId, { filters });
    let entitlements = accounts.map((a) => deserializeEntitlement(a.account.data as Buffer));
    if (opts?.activeOnly) {
      const now = new Date();
      entitlements = entitlements.filter((e) => checkEntitlement(e, now).entitled);
    }
    return entitlements;
  }

  /**
   * Get mint delegation details for a wallet on a specific product.
   *
   * @param productId - Product ID (32-byte hex string)
   * @param delegateWallet - Delegate's Solana wallet address
   * @returns MintDelegate with expiration and remaining mints, or null if not found
   */
  async getDelegate(productId: string, delegateWallet: string): Promise<MintDelegate | null> {
    const [pda] = deriveDelegatePda(productId, delegateWallet, this.programId);
    const account = await this.fetchAccount(pda, `delegate:${productId}:${delegateWallet}`);
    return account ? deserializeDelegate(account) : null;
  }

  private async fetchAccount(pda: PublicKey, cacheKey: string): Promise<Buffer | null> {
    if (this.cache) {
      const cached = await this.cache.get<Buffer>(cacheKey);
      if (cached !== null) {
        this.logger.debug('Cache hit', { key: cacheKey });
        return cached;
      }
    }

    const accountInfo = await this.connection.getAccountInfo(pda);
    if (!accountInfo) return null;

    if (this.cache) {
      await this.cache.set(cacheKey, accountInfo.data, this.cacheTtlMs);
    }

    return accountInfo.data as Buffer;
  }
}

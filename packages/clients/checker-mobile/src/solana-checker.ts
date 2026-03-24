/**
 * Lightweight Solana entitlement checker using direct JSON-RPC calls.
 *
 * No dependency on @solana/web3.js — uses fetch() for RPC and
 * @noble/hashes + @noble/curves for PDA derivation.
 *
 * Works in React Native, browsers, and Node.js.
 */
import type {
  ChainReader,
  Entitlement,
  EntitlementCheck,
  EntitlementCheckBatch,
  Product,
  Logger,
} from '@doubloon/core';
import { checkEntitlement, checkEntitlements, nullLogger } from '@doubloon/core';
import { jsonRpcCall, jsonRpcBatch } from './rpc.js';
import { deriveEntitlementAddress, deriveProductAddress } from './solana-pda.js';
import { deserializeEntitlement, deserializeProduct } from './solana-deserialize.js';

export interface MobileSolanaCheckerConfig {
  /** Solana JSON-RPC endpoint URL. */
  rpcUrl: string;
  /** Doubloon program ID (base58). */
  programId: string;
  /** RPC commitment level. Default: 'confirmed'. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Optional logger. */
  logger?: Logger;
}

interface SolanaAccountInfo {
  data: [string, string]; // [base64Data, encoding]
  executable: boolean;
  lamports: number;
  owner: string;
}

interface GetAccountInfoResult {
  value: SolanaAccountInfo | null;
}

interface GetMultipleAccountsResult {
  value: Array<SolanaAccountInfo | null>;
}

/**
 * Lightweight Solana entitlement checker.
 *
 * Queries Solana RPC directly from the device — no Doubloon server needed.
 * Implements ChainReader for drop-in compatibility with existing code.
 *
 * @example
 * ```typescript
 * import { MobileSolanaChecker } from '@doubloon/checker-mobile';
 *
 * const checker = new MobileSolanaChecker({
 *   rpcUrl: 'https://api.mainnet-beta.solana.com',
 *   programId: 'Dub1oon11111111111111111111111111111111111',
 * });
 *
 * const result = await checker.checkEntitlement(productIdHex, walletBase58);
 * if (result.entitled) {
 *   // Grant access
 * }
 * ```
 */
export class MobileSolanaChecker implements ChainReader {
  private readonly rpcUrl: string;
  private readonly programId: string;
  private readonly commitment: string;
  private readonly logger: Logger;

  constructor(config: MobileSolanaCheckerConfig) {
    this.rpcUrl = config.rpcUrl;
    this.programId = config.programId;
    this.commitment = config.commitment ?? 'confirmed';
    this.logger = config.logger ?? nullLogger;
  }

  async checkEntitlement(productId: string, wallet: string): Promise<EntitlementCheck> {
    const entitlement = await this.getEntitlement(productId, wallet);
    return checkEntitlement(entitlement);
  }

  async checkEntitlements(productIds: string[], wallet: string): Promise<EntitlementCheckBatch> {
    if (productIds.length === 0) {
      return { results: {}, user: wallet, checkedAt: new Date() };
    }

    // Derive all PDA addresses
    const addresses = productIds.map((pid) =>
      deriveEntitlementAddress(pid, wallet, this.programId),
    );

    this.logger.debug('checkEntitlements batch', { count: productIds.length });

    // Fetch all accounts in a single RPC call
    const result = await jsonRpcCall<GetMultipleAccountsResult>(
      this.rpcUrl,
      'getMultipleAccounts',
      [addresses, { encoding: 'base64', commitment: this.commitment }],
    );

    const entitlements: Record<string, Entitlement | null> = {};
    for (let i = 0; i < productIds.length; i++) {
      const account = result.value[i];
      entitlements[productIds[i]] = account
        ? deserializeEntitlement(base64ToBytes(account.data[0]))
        : null;
    }

    return checkEntitlements(entitlements, new Date(), wallet);
  }

  async getEntitlement(productId: string, wallet: string): Promise<Entitlement | null> {
    const address = deriveEntitlementAddress(productId, wallet, this.programId);
    this.logger.debug('getEntitlement', { productId, wallet, pda: address });

    const result = await jsonRpcCall<GetAccountInfoResult>(
      this.rpcUrl,
      'getAccountInfo',
      [address, { encoding: 'base64', commitment: this.commitment }],
    );

    if (!result.value) return null;
    return deserializeEntitlement(base64ToBytes(result.value.data[0]));
  }

  async getProduct(productId: string): Promise<Product | null> {
    const address = deriveProductAddress(productId, this.programId);
    this.logger.debug('getProduct', { productId, pda: address });

    const result = await jsonRpcCall<GetAccountInfoResult>(
      this.rpcUrl,
      'getAccountInfo',
      [address, { encoding: 'base64', commitment: this.commitment }],
    );

    if (!result.value) return null;
    return deserializeProduct(base64ToBytes(result.value.data[0]));
  }
}

/**
 * Decode base64 to Uint8Array.
 * Uses atob() which is available in React Native and browsers.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

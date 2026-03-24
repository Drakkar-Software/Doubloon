/**
 * Lightweight EVM entitlement checker using direct JSON-RPC calls.
 *
 * Zero external dependencies — uses fetch() for `eth_call` and manual
 * ABI encoding/decoding for the Doubloon contract view functions.
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
import { checkEntitlement, checkEntitlements, nullLogger, U8_TO_ENTITLEMENT_SOURCE } from '@doubloon/core';
import { jsonRpcCall } from './rpc.js';
import {
  encodeIsEntitled,
  encodeGetEntitlement,
  encodeGetProduct,
  decodeBool,
  decodeGetEntitlement,
  decodeGetProduct,
  type EvmEntitlementRaw,
} from './evm-abi.js';

export interface MobileEvmCheckerConfig {
  /** EVM JSON-RPC endpoint URL. */
  rpcUrl: string;
  /** Doubloon contract address (0x-prefixed). */
  contractAddress: string;
  /** Optional logger. */
  logger?: Logger;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Lightweight EVM entitlement checker.
 *
 * Calls the Doubloon Solidity contract's `view` functions directly via
 * `eth_call` — zero gas cost, no wallet needed, no server required.
 *
 * Implements ChainReader for drop-in compatibility.
 *
 * @example
 * ```typescript
 * import { MobileEvmChecker } from '@doubloon/checker-mobile';
 *
 * const checker = new MobileEvmChecker({
 *   rpcUrl: 'https://eth.llamarpc.com',
 *   contractAddress: '0xYourDoubloonContract...',
 * });
 *
 * const result = await checker.checkEntitlement(productIdHex, userAddress);
 * if (result.entitled) {
 *   // Grant access
 * }
 * ```
 */
export class MobileEvmChecker implements ChainReader {
  private readonly rpcUrl: string;
  private readonly contractAddress: string;
  private readonly logger: Logger;

  constructor(config: MobileEvmCheckerConfig) {
    this.rpcUrl = config.rpcUrl;
    this.contractAddress = config.contractAddress;
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

    // Check all products in parallel
    const checks = await Promise.all(
      productIds.map((pid) => this.getEntitlement(pid, wallet)),
    );

    const entitlements: Record<string, Entitlement | null> = {};
    for (let i = 0; i < productIds.length; i++) {
      entitlements[productIds[i]] = checks[i];
    }

    return checkEntitlements(entitlements, new Date(), wallet);
  }

  /**
   * Check if a user is entitled using the contract's `isEntitled` view function.
   * Simpler and cheaper than `getEntitlement` — returns only a boolean.
   */
  async isEntitled(productId: string, wallet: string): Promise<boolean> {
    this.logger.debug('isEntitled', { productId, wallet });
    const calldata = encodeIsEntitled(productId, wallet);
    const result = await this.ethCall(calldata);
    return decodeBool(result);
  }

  async getEntitlement(productId: string, wallet: string): Promise<Entitlement | null> {
    this.logger.debug('getEntitlement', { productId, wallet });
    const calldata = encodeGetEntitlement(productId, wallet);
    const result = await this.ethCall(calldata);

    // Empty or too-short result means no data
    const clean = result.startsWith('0x') ? result.slice(2) : result;
    if (clean.length < 64) return null;

    const raw = decodeGetEntitlement(result);

    // The contract returns a struct with exists=false for non-existent entitlements
    if (!raw.exists) return null;

    return evmRawToEntitlement(raw);
  }

  async getProduct(productId: string): Promise<Product | null> {
    this.logger.debug('getProduct', { productId });
    const calldata = encodeGetProduct(productId);
    const result = await this.ethCall(calldata);

    const clean = result.startsWith('0x') ? result.slice(2) : result;
    if (clean.length < 64) return null;

    const raw = decodeGetProduct(result);
    if (!raw.exists) return null;

    return {
      creator: raw.creator,
      productId: raw.productId,
      name: raw.name,
      metadataUri: raw.metadataUri,
      createdAt: new Date(raw.createdAt * 1000),
      updatedAt: new Date(raw.updatedAt * 1000),
      active: raw.active,
      frozen: raw.frozen,
      entitlementCount: raw.entitlementCount,
      delegateCount: raw.delegateCount,
      defaultDuration: raw.defaultDuration,
    };
  }

  private async ethCall(data: string): Promise<string> {
    return jsonRpcCall<string>(this.rpcUrl, 'eth_call', [
      { to: this.contractAddress, data: '0x' + data },
      'latest',
    ]);
  }
}

function evmRawToEntitlement(raw: EvmEntitlementRaw): Entitlement {
  return {
    productId: raw.productId,
    user: raw.user,
    grantedAt: new Date(raw.grantedAt * 1000),
    expiresAt: raw.expiresAt === 0 ? null : new Date(raw.expiresAt * 1000),
    autoRenew: raw.autoRenew,
    source: U8_TO_ENTITLEMENT_SOURCE[raw.source] ?? 'platform',
    sourceId: raw.sourceId,
    active: raw.active,
    revokedAt: raw.revokedAt === 0 ? null : new Date(raw.revokedAt * 1000),
    revokedBy: raw.revokedBy === ZERO_ADDRESS ? null : raw.revokedBy,
  };
}

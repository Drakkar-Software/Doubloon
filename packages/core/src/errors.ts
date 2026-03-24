import type { Chain, Store } from './types.js';

export type ErrorCode =
  // Chain
  | 'RPC_ERROR'
  | 'TRANSACTION_FAILED'
  | 'ACCOUNT_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'AUTHORITY_MISMATCH'
  | 'PRODUCT_NOT_ACTIVE'
  | 'PRODUCT_FROZEN'
  | 'DELEGATE_EXPIRED'
  | 'DELEGATE_EXHAUSTED'
  // Store
  | 'INVALID_RECEIPT'
  | 'INVALID_SIGNATURE'
  | 'STORE_API_ERROR'
  | 'STORE_RATE_LIMITED'
  | 'ENVIRONMENT_MISMATCH'
  // Identity
  | 'WALLET_NOT_LINKED'
  | 'SIGNATURE_INVALID'
  // Config
  | 'PRODUCT_NOT_MAPPED'
  | 'MISSING_CREDENTIALS'
  | 'INVALID_SLUG'
  // General
  | 'NOT_SUPPORTED'
  | 'DUPLICATE_EVENT';

/**
 * Doubloon error class with contextual metadata.
 *
 * Extends Error with structured error codes, store/chain context, and retryability flag.
 * Used throughout Doubloon to provide context-aware error handling and logging.
 *
 * @example
 * throw new DoubloonError('PRODUCT_NOT_MAPPED', 'Unknown Stripe price ID', {
 *   store: 'stripe',
 *   retryable: false,
 * });
 */
export class DoubloonError extends Error {
  readonly code: ErrorCode;
  readonly store?: Store;
  readonly chain?: Chain;
  readonly retryable: boolean;
  override readonly cause?: Error;

  /**
   * Create a DoubloonError.
   *
   * @param code - Error code identifying the error type
   * @param message - Human-readable error message
   * @param opts - Optional metadata: store, chain, retryable flag, and cause
   */
  constructor(
    code: ErrorCode,
    message: string,
    opts?: { store?: Store; chain?: Chain; retryable?: boolean; cause?: Error },
  ) {
    super(message);
    this.name = 'DoubloonError';
    this.code = code;
    this.store = opts?.store;
    this.chain = opts?.chain;
    this.retryable = opts?.retryable ?? false;
    this.cause = opts?.cause;
  }
}

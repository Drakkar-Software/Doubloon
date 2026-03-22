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

export class DoubloonError extends Error {
  readonly code: ErrorCode;
  readonly store?: Store;
  readonly chain?: Chain;
  readonly retryable: boolean;
  override readonly cause?: Error;

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

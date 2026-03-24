// Solana mobile checker
export { MobileSolanaChecker } from './solana-checker.js';
export type { MobileSolanaCheckerConfig } from './solana-checker.js';

// EVM mobile checker
export { MobileEvmChecker } from './evm-checker.js';
export type { MobileEvmCheckerConfig } from './evm-checker.js';

// Solana PDA utilities (for advanced use / pre-computation)
export {
  deriveEntitlementAddress,
  deriveProductAddress,
  deriveProductIdHex,
  findProgramAddress,
  base58Decode,
  base58Encode,
  hexToBytes,
  bytesToHex,
} from './solana-pda.js';

// Portable deserialization (for advanced use)
export {
  deserializeEntitlement as deserializeSolanaEntitlement,
  deserializeProduct as deserializeSolanaProduct,
} from './solana-deserialize.js';

// EVM ABI utilities (for advanced use)
export {
  encodeIsEntitled,
  encodeGetEntitlement,
  encodeGetProduct,
  decodeBool,
  decodeGetEntitlement,
  decodeGetProduct,
  SELECTORS,
} from './evm-abi.js';

// RPC utilities
export { jsonRpcCall, jsonRpcBatch } from './rpc.js';
export type { BatchResult } from './rpc.js';

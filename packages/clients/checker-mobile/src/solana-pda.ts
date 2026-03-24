/**
 * Lightweight Solana PDA derivation.
 *
 * Uses @noble/hashes (SHA-256) and @noble/curves (ed25519 on-curve check).
 * These are tiny, audited, zero-dependency libraries that work in
 * React Native, browsers, and Node.js.
 *
 * If @noble libs are unavailable, use pre-computed PDA addresses instead
 * via MobileSolanaChecker's `entitlementAddress` option.
 */
import { sha256 } from '@noble/hashes/sha256';
import { edwardsToMontgomeryPub } from '@noble/curves/ed25519';

const MAX_SEED_LENGTH = 32;
const PDA_MARKER = 'ProgramDerivedAddress';

/**
 * Decode a base58-encoded string to bytes.
 * Minimal implementation — no external dependency.
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(str: string): Uint8Array {
  // Count leading '1's (each maps to a 0x00 byte)
  let leadingZeros = 0;
  for (const char of str) {
    if (char !== '1') break;
    leadingZeros++;
  }

  // Convert base58 number to bytes (little-endian during computation)
  const bytes: number[] = [];
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 char: ${char}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Remove trailing zeros in little-endian = leading zeros in big-endian (already counted)
  while (bytes.length > 0 && bytes[bytes.length - 1] === 0) {
    bytes.pop();
  }

  // Prepend leading zero bytes, then the number in big-endian
  const result = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    result[leadingZeros + i] = bytes[bytes.length - 1 - i];
  }
  return result;
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  // Remove trailing zeros in digits (leading zeros in the number representation)
  while (digits.length > 0 && digits[digits.length - 1] === 0) {
    digits.pop();
  }

  let result = '';
  // Leading '1's for each leading zero byte
  for (const byte of bytes) {
    if (byte !== 0) break;
    result += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]];
  }
  return result;
}

/**
 * Check if a 32-byte value is on the ed25519 curve.
 * PDA addresses must NOT be on the curve.
 */
function isOnCurve(point: Uint8Array): boolean {
  try {
    edwardsToMontgomeryPub(point);
    return true;
  } catch {
    return false;
  }
}

/**
 * Concatenate multiple Uint8Arrays.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Hex string to bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid hex string: length ${hex.length} is not even`);
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string: contains non-hexadecimal characters');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Bytes to hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Find a program-derived address (PDA) for the given seeds and program ID.
 * Mirrors Solana's `PublicKey.findProgramAddressSync`.
 *
 * @param seeds - Array of seed buffers (each max 32 bytes).
 * @param programId - Program ID as base58 string.
 * @returns [address as base58 string, bump seed].
 */
export function findProgramAddress(
  seeds: Uint8Array[],
  programId: string,
): [string, number] {
  const programIdBytes = base58Decode(programId);
  const marker = new TextEncoder().encode(PDA_MARKER);

  for (let bump = 255; bump >= 0; bump--) {
    const hashInput = concatBytes(
      ...seeds,
      new Uint8Array([bump]),
      programIdBytes,
      marker,
    );
    const hash = sha256(hashInput);

    if (!isOnCurve(hash)) {
      return [base58Encode(hash), bump];
    }
  }

  throw new Error('Could not find PDA');
}

/**
 * Derive the Solana entitlement PDA address.
 *
 * Seeds: ["entitlement", productId (32 bytes), userPubkey (32 bytes)]
 */
export function deriveEntitlementAddress(
  productIdHex: string,
  userWalletBase58: string,
  programId: string,
): string {
  const [address] = findProgramAddress(
    [
      new TextEncoder().encode('entitlement'),
      hexToBytes(productIdHex),
      base58Decode(userWalletBase58),
    ],
    programId,
  );
  return address;
}

/**
 * Derive the Solana product PDA address.
 *
 * Seeds: ["product", productId (32 bytes)]
 */
export function deriveProductAddress(
  productIdHex: string,
  programId: string,
): string {
  const [address] = findProgramAddress(
    [
      new TextEncoder().encode('product'),
      hexToBytes(productIdHex),
    ],
    programId,
  );
  return address;
}

/**
 * Derive a product ID hex from a human-readable slug (SHA-256).
 * Matches @doubloon/core's `deriveProductIdHex` without Node.js crypto.
 */
export function deriveProductIdHex(slug: string): string {
  const bytes = new TextEncoder().encode(slug);
  return bytesToHex(sha256(bytes));
}

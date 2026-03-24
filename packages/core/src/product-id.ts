import { createHash } from 'node:crypto';
import { DoubloonError } from './errors.js';

/**
 * Validate a product slug.
 *
 * Rules:
 * - Lowercase alphanumeric and hyphens only: /^[a-z0-9][a-z0-9-]*[a-z0-9]$/
 * - Min 3 chars, max 64 chars
 * - No leading/trailing hyphens
 * - No consecutive hyphens
 *
 * @throws DoubloonError with code INVALID_SLUG if validation fails.
 */
export function validateSlug(slug: string): void {
  if (slug.length < 3 || slug.length > 64) {
    throw new DoubloonError('INVALID_SLUG', `Slug must be 3-64 chars, got ${slug.length}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    throw new DoubloonError(
      'INVALID_SLUG',
      `Slug must be lowercase alphanumeric with hyphens, no leading/trailing hyphens: "${slug}"`,
    );
  }
  if (/--/.test(slug)) {
    throw new DoubloonError('INVALID_SLUG', `Slug must not contain consecutive hyphens: "${slug}"`);
  }
}

/**
 * Derive a 32-byte product ID from a human-readable slug.
 * The derivation is: SHA-256(UTF-8(slug)).
 * Deterministic and collision-resistant.
 *
 * @param slug - Human-readable product slug (validated: 3-64 chars, lowercase alphanumeric with hyphens).
 * @returns 32-byte Uint8Array of the SHA-256 hash.
 * @throws DoubloonError if slug validation fails.
 * @example
 * const productId = deriveProductId('premium-plan');
 * // Returns consistent 32-byte hash suitable for on-chain use
 */
export function deriveProductId(slug: string): Uint8Array {
  validateSlug(slug);
  const hash = createHash('sha256').update(slug, 'utf-8').digest();
  return new Uint8Array(hash);
}

/**
 * Derive a hex-encoded product ID from a human-readable slug.
 *
 * @param slug - Human-readable product slug.
 * @returns 64-character hex string.
 */
export function deriveProductIdHex(slug: string): string {
  return Buffer.from(deriveProductId(slug)).toString('hex');
}

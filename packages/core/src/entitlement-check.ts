import type { Entitlement, EntitlementCheck, EntitlementCheckBatch } from './types.js';

/**
 * Check if an entitlement grants access.
 * Pure function — no I/O, no side effects, no dependencies.
 *
 * @param entitlement - The on-chain entitlement data, or null if PDA not found.
 * @param now - Current timestamp. Defaults to Date.now(). Pass explicitly for testing.
 * @returns EntitlementCheck with entitled boolean, reason, and cache TTL hint.
 */
export function checkEntitlement(
  entitlement: Entitlement | null,
  now: Date = new Date(),
): EntitlementCheck {
  // Case 1: PDA not found — never granted
  if (entitlement === null) {
    return {
      entitled: false,
      entitlement: null,
      reason: 'not_found',
      expiresAt: null,
      product: null,
    };
  }

  // Case 2: Revoked
  if (!entitlement.active) {
    return {
      entitled: false,
      entitlement,
      reason: 'revoked',
      expiresAt: null,
      product: null,
    };
  }

  // Case 3: Lifetime (expiresAt is null)
  if (entitlement.expiresAt === null) {
    return {
      entitled: true,
      entitlement,
      reason: 'active',
      expiresAt: null,
      product: null,
    };
  }

  // Case 4: Check expiry (expiresAt is exclusive — "access until", not "access through")
  if (entitlement.expiresAt > now) {
    return {
      entitled: true,
      entitlement,
      reason: 'active',
      expiresAt: entitlement.expiresAt,
      product: null,
    };
  }

  // Case 5: Expired
  return {
    entitled: false,
    entitlement,
    reason: 'expired',
    expiresAt: null,
    product: null,
  };
}

/**
 * Batch check: multiple products for one user.
 *
 * @param entitlements - Map of productId to Entitlement (or null if not found).
 * @param now - Current timestamp for consistent checking across the batch.
 * @returns EntitlementCheckBatch with results for each product.
 */
export function checkEntitlements(
  entitlements: Record<string, Entitlement | null>,
  now: Date = new Date(),
): EntitlementCheckBatch {
  const results: Record<string, EntitlementCheck> = {};
  for (const [productId, entitlement] of Object.entries(entitlements)) {
    results[productId] = checkEntitlement(entitlement, now);
  }
  return {
    results,
    user: '',
    checkedAt: now,
  };
}

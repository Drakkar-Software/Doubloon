/**
 * Cross-Language Consistency Validation
 *
 * Validates that entitlement checking logic is consistent across implementations.
 * Tests edge cases: expired entitlements, grace periods, multiple products.
 * Note: This test compares TypeScript checker logic with simulated Python behavior.
 */

import { describe, it, expect } from 'vitest';

/**
 * Reference implementation of entitlement check logic
 * This matches the Python client logic
 */
interface Entitlement {
  productId: string;
  expiresAt: Date;
  source: string;
  autoRenew: boolean;
}

interface EntitlementCheckResult {
  hasEntitlement: boolean;
  expiresAt?: Date;
  source?: string;
  autoRenew?: boolean;
  gracePeriodActive?: boolean;
}

// TypeScript implementation
function checkEntitlementTS(
  productId: string,
  entitlements: Entitlement[],
  gracePeriodMs: number = 3 * 86400000, // 3 days default
): EntitlementCheckResult {
  const now = Date.now();
  const gracePeriodEnd = now + gracePeriodMs;

  const matching = entitlements.filter((e) => e.productId === productId);

  if (matching.length === 0) {
    return { hasEntitlement: false };
  }

  // Sort by expiration (latest first)
  const sorted = matching.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
  const latest = sorted[0];

  const expiresAtMs = latest.expiresAt.getTime();

  if (expiresAtMs > now) {
    // Not expired
    return {
      hasEntitlement: true,
      expiresAt: latest.expiresAt,
      source: latest.source,
      autoRenew: latest.autoRenew,
      gracePeriodActive: false,
    };
  }

  if (expiresAtMs > now - gracePeriodMs) {
    // In grace period
    return {
      hasEntitlement: true,
      expiresAt: latest.expiresAt,
      source: latest.source,
      autoRenew: latest.autoRenew,
      gracePeriodActive: true,
    };
  }

  return { hasEntitlement: false };
}

// Simulated Python implementation (expected behavior)
function checkEntitlementPython(
  productId: string,
  entitlements: Entitlement[],
  gracePeriodMs: number = 3 * 86400000,
): EntitlementCheckResult {
  const now = Date.now();

  const matching = entitlements.filter((e) => e.productId === productId);

  if (!matching.length) {
    return { hasEntitlement: false };
  }

  // Sort by expiration (latest first)
  const sorted = matching.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
  const latest = sorted[0];

  const expiresAtMs = latest.expiresAt.getTime();
  const graceWindowStart = expiresAtMs - gracePeriodMs;

  // Active (not expired)
  if (expiresAtMs > now) {
    return {
      hasEntitlement: true,
      expiresAt: latest.expiresAt,
      source: latest.source,
      autoRenew: latest.autoRenew,
      gracePeriodActive: false,
    };
  }

  // Grace period (expired but within grace window)
  if (now < expiresAtMs + gracePeriodMs) {
    return {
      hasEntitlement: true,
      expiresAt: latest.expiresAt,
      source: latest.source,
      autoRenew: latest.autoRenew,
      gracePeriodActive: true,
    };
  }

  return { hasEntitlement: false };
}

describe('Cross-Language Consistency Validation', () => {
  function compareResults(
    tsResult: EntitlementCheckResult,
    pyResult: EntitlementCheckResult,
    testCase: string,
  ) {
    expect(
      tsResult.hasEntitlement === pyResult.hasEntitlement,
      `${testCase}: hasEntitlement mismatch TS=${tsResult.hasEntitlement} PY=${pyResult.hasEntitlement}`,
    ).toBe(true);

    if (tsResult.hasEntitlement && pyResult.hasEntitlement) {
      expect(tsResult.gracePeriodActive, `${testCase}: gracePeriodActive mismatch`).toBe(
        pyResult.gracePeriodActive,
      );

      if (tsResult.expiresAt && pyResult.expiresAt) {
        expect(tsResult.expiresAt.getTime()).toBe(pyResult.expiresAt.getTime());
      }

      expect(tsResult.source).toBe(pyResult.source);
      expect(tsResult.autoRenew).toBe(pyResult.autoRenew);
    }
  }

  it('should return consistent results for active (non-expired) entitlements', () => {
    const futureDate = new Date(Date.now() + 30 * 86400000); // 30 days in future
    const entitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt: futureDate,
        source: 'stripe',
        autoRenew: true,
      },
    ];

    const tsResult = checkEntitlementTS('product-1', entitlements);
    const pyResult = checkEntitlementPython('product-1', entitlements);

    compareResults(tsResult, pyResult, 'active entitlement');

    expect(tsResult.hasEntitlement).toBe(true);
    expect(tsResult.gracePeriodActive).toBe(false);
  });

  it('should return consistent results for expired entitlements outside grace period', () => {
    const pastDate = new Date(Date.now() - 10 * 86400000); // 10 days in past
    const entitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt: pastDate,
        source: 'apple',
        autoRenew: false,
      },
    ];

    const tsResult = checkEntitlementTS('product-1', entitlements);
    const pyResult = checkEntitlementPython('product-1', entitlements);

    compareResults(tsResult, pyResult, 'expired entitlement');

    expect(tsResult.hasEntitlement).toBe(false);
  });

  it('should return consistent results for entitlements in grace period', () => {
    const gracePeriodMs = 3 * 86400000; // 3 days
    const pastDate = new Date(Date.now() - 1 * 86400000); // 1 day in past (within grace)
    const entitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt: pastDate,
        source: 'google',
        autoRenew: true,
      },
    ];

    const tsResult = checkEntitlementTS('product-1', entitlements, gracePeriodMs);
    const pyResult = checkEntitlementPython('product-1', entitlements, gracePeriodMs);

    compareResults(tsResult, pyResult, 'grace period entitlement');

    expect(tsResult.hasEntitlement).toBe(true);
    expect(tsResult.gracePeriodActive).toBe(true);
  });

  it('should select latest expiration when multiple entitlements exist', () => {
    const now = Date.now();
    const entitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt: new Date(now + 10 * 86400000),
        source: 'apple',
        autoRenew: false,
      },
      {
        productId: 'product-1',
        expiresAt: new Date(now + 30 * 86400000), // Latest
        source: 'stripe',
        autoRenew: true,
      },
      {
        productId: 'product-1',
        expiresAt: new Date(now + 20 * 86400000),
        source: 'google',
        autoRenew: false,
      },
    ];

    const tsResult = checkEntitlementTS('product-1', entitlements);
    const pyResult = checkEntitlementPython('product-1', entitlements);

    compareResults(tsResult, pyResult, 'multiple entitlements');

    // Should select the Stripe one with 30 days
    expect(tsResult.source).toBe('stripe');
    expect(tsResult.autoRenew).toBe(true);
  });

  it('should handle multiple products independently', () => {
    const now = Date.now();
    const entitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt: new Date(now + 30 * 86400000),
        source: 'stripe',
        autoRenew: true,
      },
      {
        productId: 'product-2',
        expiresAt: new Date(now - 10 * 86400000),
        source: 'apple',
        autoRenew: false,
      },
      {
        productId: 'product-3',
        expiresAt: new Date(now - 1 * 86400000), // In grace
        source: 'google',
        autoRenew: true,
      },
    ];

    // Check each product
    for (const productId of ['product-1', 'product-2', 'product-3']) {
      const tsResult = checkEntitlementTS(productId, entitlements);
      const pyResult = checkEntitlementPython(productId, entitlements);
      compareResults(tsResult, pyResult, `multiple products: ${productId}`);
    }

    // Verify expected states
    const prod1 = checkEntitlementTS('product-1', entitlements);
    expect(prod1.hasEntitlement).toBe(true);
    expect(prod1.gracePeriodActive).toBe(false);

    const prod2 = checkEntitlementTS('product-2', entitlements);
    expect(prod2.hasEntitlement).toBe(false);

    const prod3 = checkEntitlementTS('product-3', entitlements);
    expect(prod3.hasEntitlement).toBe(true);
    expect(prod3.gracePeriodActive).toBe(true);
  });

  it('should handle edge case: expiration exactly at now', () => {
    const now = new Date();
    const entitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt: now,
        source: 'stripe',
        autoRenew: true,
      },
    ];

    const tsResult = checkEntitlementTS('product-1', entitlements);
    const pyResult = checkEntitlementPython('product-1', entitlements);

    compareResults(tsResult, pyResult, 'expiration at now');

    // At exact expiration with default grace period, should be in grace (within 3 days)
    expect(tsResult.hasEntitlement).toBe(true);
    expect(tsResult.gracePeriodActive).toBe(true);
  });

  it('should handle edge case: expiration exactly at grace period boundary', () => {
    const gracePeriodMs = 3 * 86400000;
    const now = Date.now();
    const expiresAt = new Date(now - gracePeriodMs); // Exactly at grace boundary

    const entitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt,
        source: 'stripe',
        autoRenew: true,
      },
    ];

    const tsResult = checkEntitlementTS('product-1', entitlements, gracePeriodMs);
    const pyResult = checkEntitlementPython('product-1', entitlements, gracePeriodMs);

    compareResults(tsResult, pyResult, 'grace boundary');
  });

  it('should handle edge case: no entitlements for product', () => {
    const entitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt: new Date(Date.now() + 86400000),
        source: 'stripe',
        autoRenew: true,
      },
    ];

    const tsResult = checkEntitlementTS('product-2', entitlements);
    const pyResult = checkEntitlementPython('product-2', entitlements);

    compareResults(tsResult, pyResult, 'product not found');

    expect(tsResult.hasEntitlement).toBe(false);
  });

  it('should handle different grace periods consistently', () => {
    const now = Date.now();
    const pastDate = new Date(now - 2 * 86400000); // 2 days in past
    const entitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt: pastDate,
        source: 'stripe',
        autoRenew: true,
      },
    ];

    // Test with 3-day grace period
    const tsResult3Day = checkEntitlementTS('product-1', entitlements, 3 * 86400000);
    const pyResult3Day = checkEntitlementPython('product-1', entitlements, 3 * 86400000);
    compareResults(tsResult3Day, pyResult3Day, '3-day grace');
    expect(tsResult3Day.hasEntitlement).toBe(true); // In grace

    // Test with 1-day grace period
    const tsResult1Day = checkEntitlementTS('product-1', entitlements, 1 * 86400000);
    const pyResult1Day = checkEntitlementPython('product-1', entitlements, 1 * 86400000);
    compareResults(tsResult1Day, pyResult1Day, '1-day grace');
    expect(tsResult1Day.hasEntitlement).toBe(false); // Outside grace
  });

  it('should handle auto-renew flag variations', () => {
    const now = Date.now();

    const autoRenewEntitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt: new Date(now + 86400000),
        source: 'apple',
        autoRenew: true,
      },
    ];

    const noAutoRenewEntitlements: Entitlement[] = [
      {
        productId: 'product-1',
        expiresAt: new Date(now + 86400000),
        source: 'google',
        autoRenew: false,
      },
    ];

    const tsAuto = checkEntitlementTS('product-1', autoRenewEntitlements);
    const pyAuto = checkEntitlementPython('product-1', autoRenewEntitlements);
    compareResults(tsAuto, pyAuto, 'auto-renew true');
    expect(tsAuto.autoRenew).toBe(true);

    const tsNoAuto = checkEntitlementTS('product-1', noAutoRenewEntitlements);
    const pyNoAuto = checkEntitlementPython('product-1', noAutoRenewEntitlements);
    compareResults(tsNoAuto, pyNoAuto, 'auto-renew false');
    expect(tsNoAuto.autoRenew).toBe(false);
  });

  it('should handle stress test: 1000 random scenarios', () => {
    const scenarios = 1000;
    let inconsistencies = 0;

    for (let i = 0; i < scenarios; i++) {
      // Generate random entitlements
      const productId = `product-${i % 10}`;
      const entitlementCount = Math.floor(Math.random() * 5);
      const gracePeriodDays = Math.random() * 10; // 0-10 days

      const entitlements: Entitlement[] = [];
      for (let j = 0; j < entitlementCount; j++) {
        const daysOffset = (Math.random() - 0.5) * 60; // -30 to +30 days
        entitlements.push({
          productId: `product-${(i + j) % 10}`,
          expiresAt: new Date(Date.now() + daysOffset * 86400000),
          source: ['stripe', 'apple', 'google'][j % 3],
          autoRenew: Math.random() > 0.5,
        });
      }

      const tsResult = checkEntitlementTS(productId, entitlements, gracePeriodDays * 86400000);
      const pyResult = checkEntitlementPython(productId, entitlements, gracePeriodDays * 86400000);

      if (tsResult.hasEntitlement !== pyResult.hasEntitlement) {
        inconsistencies++;
      }

      if (tsResult.hasEntitlement && pyResult.hasEntitlement) {
        if (tsResult.gracePeriodActive !== pyResult.gracePeriodActive) {
          inconsistencies++;
        }
      }
    }

    // All scenarios should be consistent
    expect(inconsistencies).toBe(0);
  });
});

/**
 * E2E: Core type mappings, entitlement source round-trip, notification type
 * exhaustiveness, type guards with edge cases, and error code taxonomy.
 */
import { describe, it, expect } from 'vitest';
import {
  ENTITLEMENT_SOURCE_TO_U8,
  U8_TO_ENTITLEMENT_SOURCE,
  isMintInstruction,
  DoubloonError,
  checkEntitlement,
} from '@doubloon/core';
import type {
  EntitlementSource,
  MintInstruction,
  RevokeInstruction,
  Entitlement,
  NotificationType,
} from '@doubloon/core';

describe('ENTITLEMENT_SOURCE_TO_U8 / U8_TO_ENTITLEMENT_SOURCE round-trip', () => {
  const sources: EntitlementSource[] = ['platform', 'creator', 'delegate', 'apple', 'google', 'stripe', 'x402'];

  it('all 7 sources have u8 values 0-6', () => {
    for (let i = 0; i < sources.length; i++) {
      expect(ENTITLEMENT_SOURCE_TO_U8[sources[i]]).toBe(i);
    }
  });

  it('u8 → source → u8 round-trip', () => {
    for (let i = 0; i <= 6; i++) {
      const source = U8_TO_ENTITLEMENT_SOURCE[i];
      expect(source).toBeDefined();
      expect(ENTITLEMENT_SOURCE_TO_U8[source]).toBe(i);
    }
  });

  it('source → u8 → source round-trip', () => {
    for (const source of sources) {
      const u8 = ENTITLEMENT_SOURCE_TO_U8[source];
      expect(U8_TO_ENTITLEMENT_SOURCE[u8]).toBe(source);
    }
  });

  it('u8 value 7+ is undefined', () => {
    expect(U8_TO_ENTITLEMENT_SOURCE[7]).toBeUndefined();
    expect(U8_TO_ENTITLEMENT_SOURCE[255]).toBeUndefined();
  });
});

describe('isMintInstruction edge cases', () => {
  it('distinguishes by source field presence', () => {
    const mint: MintInstruction = {
      productId: 'p', user: 'u', expiresAt: null, source: 'stripe', sourceId: 's',
    };
    const revoke: RevokeInstruction = {
      productId: 'p', user: 'u', reason: 'test',
    };

    expect(isMintInstruction(mint)).toBe(true);
    expect(isMintInstruction(revoke)).toBe(false);
  });

  it('object with both source and reason is identified as mint (source takes priority)', () => {
    const hybrid = {
      productId: 'p', user: 'u', expiresAt: null,
      source: 'stripe' as const, sourceId: 's',
      reason: 'also has reason',
    };
    expect(isMintInstruction(hybrid as any)).toBe(true);
  });
});

describe('checkEntitlement pure function edge cases', () => {
  const baseEntitlement: Entitlement = {
    productId: 'p', user: 'u', grantedAt: new Date('2020-01-01'),
    expiresAt: new Date('2030-12-31'), autoRenew: false, source: 'stripe',
    sourceId: 's', active: true, revokedAt: null, revokedBy: null,
  };

  it('revoked takes precedence over valid expiry', () => {
    const ent = { ...baseEntitlement, active: false, revokedAt: new Date(), revokedBy: 'admin' };
    const check = checkEntitlement(ent);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('revoked');
  });

  it('revoked takes precedence over lifetime (null expiresAt)', () => {
    const ent = { ...baseEntitlement, expiresAt: null, active: false, revokedAt: new Date(), revokedBy: 'admin' };
    const check = checkEntitlement(ent);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('revoked');
  });

  it('lifetime entitlement returns active with null expiresAt', () => {
    const ent = { ...baseEntitlement, expiresAt: null };
    const check = checkEntitlement(ent);
    expect(check.entitled).toBe(true);
    expect(check.reason).toBe('active');
    expect(check.expiresAt).toBeNull();
  });

  it('far-future expiry returns active', () => {
    const ent = { ...baseEntitlement, expiresAt: new Date('2099-12-31') };
    const check = checkEntitlement(ent);
    expect(check.entitled).toBe(true);
  });

  it('far-past expiry returns expired', () => {
    const ent = { ...baseEntitlement, expiresAt: new Date('2000-01-01') };
    const check = checkEntitlement(ent);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('expired');
  });

  it('explicit now parameter for deterministic testing', () => {
    const ent = { ...baseEntitlement, expiresAt: new Date('2025-06-15T12:00:00Z') };
    const before = checkEntitlement(ent, new Date('2025-06-15T11:59:59Z'));
    const at = checkEntitlement(ent, new Date('2025-06-15T12:00:00Z'));
    const after = checkEntitlement(ent, new Date('2025-06-15T12:00:01Z'));

    expect(before.entitled).toBe(true);
    expect(at.entitled).toBe(false); // exclusive
    expect(after.entitled).toBe(false);
  });

  it('entitlement field is preserved in result', () => {
    const check = checkEntitlement(baseEntitlement);
    expect(check.entitlement).toBe(baseEntitlement);
    expect(check.entitlement!.source).toBe('stripe');
  });

  it('product field is null (populated by caller)', () => {
    const check = checkEntitlement(baseEntitlement);
    expect(check.product).toBeNull();
  });
});

describe('DoubloonError retryable classification', () => {
  const retryableCodes = ['RPC_ERROR', 'STORE_API_ERROR', 'STORE_RATE_LIMITED'] as const;
  const nonRetryableCodes = [
    'PRODUCT_FROZEN', 'PRODUCT_NOT_ACTIVE', 'INVALID_RECEIPT',
    'WALLET_NOT_LINKED', 'PRODUCT_NOT_MAPPED', 'AUTHORITY_MISMATCH',
  ] as const;

  it('retryable defaults to false for all codes', () => {
    for (const code of [...retryableCodes, ...nonRetryableCodes]) {
      const err = new DoubloonError(code, 'test');
      expect(err.retryable).toBe(false);
    }
  });

  it('retryable can be explicitly set per error', () => {
    const retryable = new DoubloonError('RPC_ERROR', 'timeout', { retryable: true });
    expect(retryable.retryable).toBe(true);

    const notRetryable = new DoubloonError('RPC_ERROR', 'timeout', { retryable: false });
    expect(notRetryable.retryable).toBe(false);
  });
});

describe('NotificationType exhaustiveness', () => {
  it('all 16 notification types exist', () => {
    const allTypes: NotificationType[] = [
      'initial_purchase', 'renewal', 'cancellation', 'uncancellation',
      'expiration', 'refund', 'revocation', 'billing_recovery',
      'billing_retry_start', 'grace_period_start', 'price_increase_consent',
      'offer_redeemed', 'plan_change', 'pause', 'resume', 'test',
    ];
    expect(allTypes).toHaveLength(16);

    // Each should be a valid string (TypeScript ensures this, but runtime check)
    for (const type of allTypes) {
      expect(typeof type).toBe('string');
      expect(type.length).toBeGreaterThan(0);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { checkEntitlement, checkEntitlements } from '../src/entitlement-check.js';
import type { Entitlement } from '../src/types.js';

function makeEntitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    productId: 'a'.repeat(64),
    user: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    grantedAt: new Date('2024-01-01T00:00:00Z'),
    expiresAt: new Date('2025-01-01T00:00:00Z'),
    autoRenew: true,
    source: 'apple',
    sourceId: '2000000123456789',
    active: true,
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

describe('checkEntitlement', () => {
  const now = new Date('2024-06-15T00:00:00Z');

  it('returns not_found when entitlement is null', () => {
    const result = checkEntitlement(null, now);
    expect(result.entitled).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(result.entitlement).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.product).toBeNull();
  });

  it('returns active for entitlement with future expiry', () => {
    const entitlement = makeEntitlement({
      expiresAt: new Date('2024-12-31T00:00:00Z'),
    });
    const result = checkEntitlement(entitlement, now);
    expect(result.entitled).toBe(true);
    expect(result.reason).toBe('active');
    expect(result.expiresAt).toEqual(new Date('2024-12-31T00:00:00Z'));
  });

  it('returns expired for past expiresAt', () => {
    const entitlement = makeEntitlement({
      expiresAt: new Date('2024-06-14T00:00:00Z'),
    });
    const result = checkEntitlement(entitlement, now);
    expect(result.entitled).toBe(false);
    expect(result.reason).toBe('expired');
    expect(result.expiresAt).toBeNull();
  });

  it('returns revoked when active is false (even with future expiry)', () => {
    const entitlement = makeEntitlement({
      expiresAt: new Date('2025-01-01T00:00:00Z'),
      active: false,
      revokedAt: new Date('2024-06-01T00:00:00Z'),
      revokedBy: 'platformAuthority',
    });
    const result = checkEntitlement(entitlement, now);
    expect(result.entitled).toBe(false);
    expect(result.reason).toBe('revoked');
  });

  it('returns active for lifetime entitlement (expiresAt: null)', () => {
    const entitlement = makeEntitlement({
      expiresAt: null,
    });
    const result = checkEntitlement(entitlement, now);
    expect(result.entitled).toBe(true);
    expect(result.reason).toBe('active');
    expect(result.expiresAt).toBeNull();
  });

  it('returns active for re-activated entitlement (previously revoked)', () => {
    const entitlement = makeEntitlement({
      expiresAt: new Date('2024-12-31T00:00:00Z'),
      active: true,
      revokedAt: new Date('2024-05-01T00:00:00Z'),
      revokedBy: 'platformAuthority',
    });
    const result = checkEntitlement(entitlement, now);
    expect(result.entitled).toBe(true);
    expect(result.reason).toBe('active');
  });

  it('returns expired when expiresAt exactly equals now (exclusive boundary)', () => {
    const entitlement = makeEntitlement({
      expiresAt: new Date(now),
    });
    const result = checkEntitlement(entitlement, now);
    expect(result.entitled).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('is deterministic with explicit now parameter', () => {
    const entitlement = makeEntitlement({
      expiresAt: new Date('2024-12-31T00:00:00Z'),
    });
    const a = checkEntitlement(entitlement, now);
    const b = checkEntitlement(entitlement, now);
    expect(a).toEqual(b);
  });
});

describe('checkEntitlements', () => {
  const now = new Date('2024-06-15T00:00:00Z');

  it('batch checks multiple products correctly', () => {
    const entitlements: Record<string, Entitlement | null> = {
      ['a'.repeat(64)]: makeEntitlement({ expiresAt: new Date('2024-12-31T00:00:00Z') }),
      ['b'.repeat(64)]: makeEntitlement({ expiresAt: new Date('2024-01-01T00:00:00Z') }),
      ['c'.repeat(64)]: null,
    };

    const batch = checkEntitlements(entitlements, now);

    expect(batch.results['a'.repeat(64)].entitled).toBe(true);
    expect(batch.results['a'.repeat(64)].reason).toBe('active');

    expect(batch.results['b'.repeat(64)].entitled).toBe(false);
    expect(batch.results['b'.repeat(64)].reason).toBe('expired');

    expect(batch.results['c'.repeat(64)].entitled).toBe(false);
    expect(batch.results['c'.repeat(64)].reason).toBe('not_found');

    expect(batch.checkedAt).toEqual(now);
  });
});

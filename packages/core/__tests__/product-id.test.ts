import { describe, it, expect } from 'vitest';
import { deriveProductId, deriveProductIdHex, validateSlug } from '../src/product-id.js';
import { DoubloonError } from '../src/errors.js';

describe('validateSlug', () => {
  it('accepts valid slugs', () => {
    expect(() => validateSlug('pro')).not.toThrow();
    expect(() => validateSlug('pro-monthly')).not.toThrow();
    expect(() => validateSlug('my-app-premium-annual-v2')).not.toThrow();
    expect(() => validateSlug('a1b')).not.toThrow();
    // 64-char slug
    expect(() => validateSlug('a'.repeat(64))).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateSlug('')).toThrow(DoubloonError);
    expect(() => validateSlug('')).toThrow('3-64 chars');
  });

  it('rejects too short (2 chars)', () => {
    expect(() => validateSlug('ab')).toThrow('3-64 chars');
  });

  it('rejects uppercase', () => {
    expect(() => validateSlug('Pro-Monthly')).toThrow('lowercase alphanumeric');
  });

  it('rejects consecutive hyphens', () => {
    expect(() => validateSlug('pro--monthly')).toThrow('consecutive hyphens');
  });

  it('rejects leading hyphen', () => {
    expect(() => validateSlug('-pro-monthly')).toThrow('lowercase alphanumeric');
  });

  it('rejects trailing hyphen', () => {
    expect(() => validateSlug('pro-monthly-')).toThrow('lowercase alphanumeric');
  });

  it('rejects too long (65 chars)', () => {
    expect(() => validateSlug('a'.repeat(65))).toThrow('3-64 chars');
  });

  it('rejects spaces', () => {
    expect(() => validateSlug('pro monthly')).toThrow('lowercase alphanumeric');
  });
});

describe('deriveProductId', () => {
  it('returns deterministic 32-byte Uint8Array', () => {
    const a = deriveProductId('pro-monthly');
    const b = deriveProductId('pro-monthly');
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
    expect(a).toBeInstanceOf(Uint8Array);
  });

  it('produces correct SHA-256 hash', async () => {
    const hex = deriveProductIdHex('pro-monthly');
    expect(hex).toHaveLength(64);

    // Verify by computing with node:crypto directly
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('pro-monthly', 'utf-8').digest('hex');
    expect(hex).toBe(expected);
  });

  it('different slugs produce different IDs', () => {
    const a = deriveProductIdHex('pro-monthly');
    const b = deriveProductIdHex('pro-annual');
    expect(a).not.toBe(b);
  });
});

describe('deriveProductIdHex', () => {
  it('returns 64-char hex string', () => {
    const hex = deriveProductIdHex('pro-monthly');
    expect(hex).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hex)).toBe(true);
  });
});

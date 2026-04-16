/**
 * Integration tests for @doubloon/anchor entitlement destination.
 *
 * Uses a mock Supabase client backed by an in-memory array to test the full
 * mint/check/revoke lifecycle. Covers all four entitlement check reasons:
 * active, not_found, expired, revoked.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAnchorDestination } from '@doubloon/anchor';
import { createProductRegistry } from '@doubloon/core';
import { mintWithRetry } from '@doubloon/server';
import type { EntitlementRow } from '@doubloon/anchor';

// ---------------------------------------------------------------------------
// Mock Supabase client backed by an in-memory store
// ---------------------------------------------------------------------------

function createMockSupabase(store: EntitlementRow[] = []) {
  const rows = store;

  function matchRows(filters: Record<string, unknown>): EntitlementRow[] {
    return rows.filter((row) =>
      Object.entries(filters).every(([col, val]) => (row as unknown as Record<string, unknown>)[col] === val),
    );
  }

  function buildQuery(table: string) {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    let selectAll = true;

    const q = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return q;
      },
      in(col: string, vals: unknown[]) {
        inFilters[col] = vals;
        return q;
      },
      select(_cols?: string) {
        return q;
      },
      single() {
        const matched = matchWithIn();
        if (matched.length === 0) return Promise.resolve({ data: null, error: { message: 'Not found' } });
        return Promise.resolve({ data: matched[0], error: null });
      },
      maybeSingle() {
        const matched = matchWithIn();
        return Promise.resolve({ data: matched[0] ?? null, error: null });
      },
      then(resolve: (v: { data: EntitlementRow[]; error: null }) => unknown) {
        const matched = matchWithIn();
        return Promise.resolve({ data: matched, error: null }).then(resolve);
      },
    };

    function matchWithIn(): EntitlementRow[] {
      return rows.filter((row) => {
        const r = row as unknown as Record<string, unknown>;
        const filterMatch = Object.entries(filters).every(([col, val]) => r[col] === val);
        const inMatch = Object.entries(inFilters).every(([col, vals]) => vals.includes(r[col]));
        return filterMatch && inMatch;
      });
    }

    return q;
  }

  const client = {
    _rows: rows,

    from(table: string) {
      return {
        select(_cols?: string) {
          return buildQuery(table);
        },

        upsert(data: Record<string, unknown>, _opts?: { onConflict?: string }) {
          const idx = rows.findIndex(
            (r) => r.product_id === data['product_id'] && r.user_wallet === data['user_wallet'],
          );
          const now = new Date().toISOString();
          const row: EntitlementRow = {
            id: idx >= 0 ? rows[idx]!.id : crypto.randomUUID(),
            product_id: data['product_id'] as string,
            user_wallet: data['user_wallet'] as string,
            slug: data['slug'] as string,
            granted_at: (data['granted_at'] as string) ?? now,
            expires_at: (data['expires_at'] as string | null) ?? null,
            auto_renew: (data['auto_renew'] as boolean) ?? false,
            source: data['source'] as string,
            source_id: data['source_id'] as string,
            active: (data['active'] as boolean) ?? true,
            revoked_at: (data['revoked_at'] as string | null) ?? null,
            revoked_by: (data['revoked_by'] as string | null) ?? null,
          };
          if (idx >= 0) {
            rows[idx] = row;
          } else {
            rows.push(row);
          }
          return {
            select(_cols?: string) {
              return this;
            },
            single() {
              return Promise.resolve({ data: row, error: null });
            },
          };
        },

        update(data: Record<string, unknown>) {
          const filters: Record<string, unknown> = {};
          const q = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return q;
            },
            select(_cols?: string) {
              return q;
            },
            single() {
              const idx = rows.findIndex((row) => {
                const r = row as unknown as Record<string, unknown>;
                return Object.entries(filters).every(([col, val]) => r[col] === val);
              });
              if (idx < 0) {
                return Promise.resolve({ data: null, error: { message: 'Row not found' } });
              }
              rows[idx] = { ...rows[idx]!, ...data } as EntitlementRow;
              return Promise.resolve({ data: rows[idx], error: null });
            },
          };
          return q;
        },
      };
    },
  };

  return client;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const PRODUCTS = [
  { slug: 'pro-monthly', name: 'Pro Monthly', defaultDuration: 2592000 },
  { slug: 'lifetime', name: 'Lifetime', defaultDuration: 0 },
];

const registry = createProductRegistry(PRODUCTS);
const PRO_ID = registry.getProductId('pro-monthly');
const LIFETIME_ID = registry.getProductId('lifetime');
const WALLET = 'wallet-abc';

let rows: EntitlementRow[];
let supabase: ReturnType<typeof createMockSupabase>;
let dest: ReturnType<typeof createAnchorDestination>;

beforeEach(() => {
  rows = [];
  supabase = createMockSupabase(rows);
  dest = createAnchorDestination({
    supabase: supabase as never,
    products: PRODUCTS,
    signerKey: 'test-service-role',
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnchorReader', () => {
  it('returns not_found for new wallet', async () => {
    const check = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('not_found');
  });

  it('returns active for active row without expiry', async () => {
    rows.push({
      id: 'row-1',
      product_id: PRO_ID,
      user_wallet: WALLET,
      slug: 'pro-monthly',
      granted_at: new Date().toISOString(),
      expires_at: null,
      auto_renew: false,
      source: 'stripe',
      source_id: 'sub_123',
      active: true,
      revoked_at: null,
      revoked_by: null,
    });

    const check = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(check.entitled).toBe(true);
    expect(check.reason).toBe('active');
    expect(check.expiresAt).toBeNull();
  });

  it('returns active for row with future expiry', async () => {
    const future = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    rows.push({
      id: 'row-2',
      product_id: PRO_ID,
      user_wallet: WALLET,
      slug: 'pro-monthly',
      granted_at: new Date().toISOString(),
      expires_at: future,
      auto_renew: true,
      source: 'apple',
      source_id: 'apple-sub-1',
      active: true,
      revoked_at: null,
      revoked_by: null,
    });

    const check = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(check.entitled).toBe(true);
    expect(check.reason).toBe('active');
    expect(check.expiresAt).toEqual(new Date(future));
  });

  it('returns expired for row with past expiry', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    rows.push({
      id: 'row-3',
      product_id: PRO_ID,
      user_wallet: WALLET,
      slug: 'pro-monthly',
      granted_at: new Date(Date.now() - 86400000).toISOString(),
      expires_at: past,
      auto_renew: false,
      source: 'stripe',
      source_id: 'sub_expired',
      active: true,
      revoked_at: null,
      revoked_by: null,
    });

    const check = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('expired');
  });

  it('returns revoked for inactive row', async () => {
    rows.push({
      id: 'row-4',
      product_id: PRO_ID,
      user_wallet: WALLET,
      slug: 'pro-monthly',
      granted_at: new Date(Date.now() - 86400000).toISOString(),
      expires_at: null,
      auto_renew: false,
      source: 'stripe',
      source_id: 'sub_revoked',
      active: false,
      revoked_at: new Date().toISOString(),
      revoked_by: 'cancellation',
    });

    const check = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(check.entitled).toBe(false);
    expect(check.reason).toBe('revoked');
  });

  it('checkEntitlements fetches multiple products in one query', async () => {
    rows.push({
      id: 'row-5',
      product_id: PRO_ID,
      user_wallet: WALLET,
      slug: 'pro-monthly',
      granted_at: new Date().toISOString(),
      expires_at: null,
      auto_renew: false,
      source: 'stripe',
      source_id: 'sub_batch',
      active: true,
      revoked_at: null,
      revoked_by: null,
    });

    const batch = await dest.reader.checkEntitlements([PRO_ID, LIFETIME_ID], WALLET);
    expect(batch.results[PRO_ID]!.entitled).toBe(true);
    expect(batch.results[LIFETIME_ID]!.entitled).toBe(false);
    expect(batch.results[LIFETIME_ID]!.reason).toBe('not_found');
  });

  it('getProduct returns entry from registry', async () => {
    const product = await dest.reader.getProduct(PRO_ID);
    expect(product).not.toBeNull();
    expect(product!.name).toBe('Pro Monthly');
    expect(product!.defaultDuration).toBe(2592000);
  });

  it('getProduct returns null for unknown productId', async () => {
    const product = await dest.reader.getProduct('0'.repeat(64));
    expect(product).toBeNull();
  });
});

describe('AnchorWriter + AnchorSigner: mint', () => {
  it('mints by inserting a new row', async () => {
    const tx = await dest.writer.mintEntitlement({
      productId: PRO_ID,
      user: WALLET,
      expiresAt: null,
      source: 'stripe',
      sourceId: 'sub_123',
      signer: 'test-service-role',
    });

    await dest.signer.signAndSend(tx);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.product_id).toBe(PRO_ID);
    expect(rows[0]!.user_wallet).toBe(WALLET);
    expect(rows[0]!.slug).toBe('pro-monthly');
    expect(rows[0]!.active).toBe(true);
    expect(rows[0]!.source).toBe('stripe');
  });

  it('mint upserts — re-subscribing reactivates existing row', async () => {
    // Pre-existing revoked row
    rows.push({
      id: 'existing-row',
      product_id: PRO_ID,
      user_wallet: WALLET,
      slug: 'pro-monthly',
      granted_at: new Date(Date.now() - 86400000).toISOString(),
      expires_at: null,
      auto_renew: false,
      source: 'stripe',
      source_id: 'sub_old',
      active: false,
      revoked_at: new Date().toISOString(),
      revoked_by: 'cancellation',
    });

    const tx = await dest.writer.mintEntitlement({
      productId: PRO_ID,
      user: WALLET,
      expiresAt: null,
      source: 'stripe',
      sourceId: 'sub_new',
      signer: 'test-service-role',
    });

    await dest.signer.signAndSend(tx);

    // Should have upserted — still only one row
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(true);
    expect(rows[0]!.source_id).toBe('sub_new');
    expect(rows[0]!.revoked_at).toBeNull();
  });

  it('mint stores expiresAt correctly', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86400 * 1000);

    const tx = await dest.writer.mintEntitlement({
      productId: PRO_ID,
      user: WALLET,
      expiresAt,
      source: 'apple',
      sourceId: 'apple-sub-1',
      signer: 'test-service-role',
    });

    await dest.signer.signAndSend(tx);

    expect(rows[0]!.expires_at).toBe(expiresAt.toISOString());
  });
});

describe('AnchorWriter + AnchorSigner: revoke', () => {
  it('revokes by setting active=false on existing row', async () => {
    rows.push({
      id: 'row-to-revoke',
      product_id: PRO_ID,
      user_wallet: WALLET,
      slug: 'pro-monthly',
      granted_at: new Date().toISOString(),
      expires_at: null,
      auto_renew: false,
      source: 'stripe',
      source_id: 'sub_123',
      active: true,
      revoked_at: null,
      revoked_by: null,
    });

    const tx = await dest.writer.revokeEntitlement({
      productId: PRO_ID,
      user: WALLET,
      reason: 'cancellation',
      signer: 'test-service-role',
    });

    await dest.signer.signAndSend(tx);

    expect(rows[0]!.active).toBe(false);
    expect(rows[0]!.revoked_by).toBe('cancellation');
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  it('revoke does not affect other users rows', async () => {
    const OTHER_WALLET = 'wallet-other';
    rows.push(
      {
        id: 'row-alice',
        product_id: PRO_ID,
        user_wallet: WALLET,
        slug: 'pro-monthly',
        granted_at: new Date().toISOString(),
        expires_at: null,
        auto_renew: false,
        source: 'stripe',
        source_id: 'sub_alice',
        active: true,
        revoked_at: null,
        revoked_by: null,
      },
      {
        id: 'row-other',
        product_id: PRO_ID,
        user_wallet: OTHER_WALLET,
        slug: 'pro-monthly',
        granted_at: new Date().toISOString(),
        expires_at: null,
        auto_renew: false,
        source: 'stripe',
        source_id: 'sub_other',
        active: true,
        revoked_at: null,
        revoked_by: null,
      },
    );

    const tx = await dest.writer.revokeEntitlement({
      productId: PRO_ID,
      user: WALLET,
      reason: 'refund',
      signer: 'test-service-role',
    });

    await dest.signer.signAndSend(tx);

    const alice = rows.find((r) => r.user_wallet === WALLET)!;
    const other = rows.find((r) => r.user_wallet === OTHER_WALLET)!;

    expect(alice.active).toBe(false);
    expect(other.active).toBe(true);
  });
});

describe('Full lifecycle', () => {
  it('mint → check (active) → revoke → check (revoked) → re-mint → check (active)', async () => {
    const instruction = {
      productId: PRO_ID,
      user: WALLET,
      expiresAt: null,
      source: 'stripe' as const,
      sourceId: 'sub_lifecycle',
      signer: 'test-service-role',
    };

    // Mint
    await dest.signer.signAndSend(await dest.writer.mintEntitlement(instruction));
    expect((await dest.reader.checkEntitlement(PRO_ID, WALLET)).entitled).toBe(true);

    // Revoke
    await dest.signer.signAndSend(
      await dest.writer.revokeEntitlement({
        productId: PRO_ID,
        user: WALLET,
        reason: 'cancellation',
        signer: 'test-service-role',
      }),
    );
    const revokedCheck = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(revokedCheck.entitled).toBe(false);
    expect(revokedCheck.reason).toBe('revoked');

    // Re-mint (resubscribe)
    await dest.signer.signAndSend(await dest.writer.mintEntitlement({ ...instruction, sourceId: 'sub_renew' }));
    const renewedCheck = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(renewedCheck.entitled).toBe(true);
    expect(renewedCheck.reason).toBe('active');
  });
});

describe('mintWithRetry integration', () => {
  it('succeeds on first attempt', async () => {
    const result = await mintWithRetry(
      dest.writer,
      dest.signer,
      {
        productId: PRO_ID,
        user: WALLET,
        expiresAt: null,
        source: 'stripe',
        sourceId: 'sub_retry_test',
      },
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 },
    );

    expect(result.success).toBe(true);
    expect(result.retryCount).toBe(0);

    const check = await dest.reader.checkEntitlement(PRO_ID, WALLET);
    expect(check.entitled).toBe(true);
  });
});

describe('ProductRegistry', () => {
  it('getSlug resolves productId to slug', () => {
    expect(dest.registry.getSlug(PRO_ID)).toBe('pro-monthly');
  });

  it('getProductId resolves slug to productId', () => {
    expect(dest.registry.getProductId('lifetime')).toBe(LIFETIME_ID);
  });

  it('throws for unknown productId', () => {
    expect(() => dest.registry.getSlug('0'.repeat(64))).toThrow('Unknown productId');
  });

  it('rejects invalid slug', () => {
    expect(() =>
      createAnchorDestination({
        supabase: supabase as never,
        products: [{ slug: 'INVALID_SLUG!', name: 'Bad', defaultDuration: 0 }],
        signerKey: 'test',
      }),
    ).toThrow('lowercase alphanumeric');
  });
});

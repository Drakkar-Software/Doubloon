/** Supabase row shape for the entitlements table. Anchor-compatible. */
export interface EntitlementRow {
  id: string;
  product_id: string;
  user_wallet: string;
  slug: string;
  granted_at: string;
  expires_at: string | null;
  auto_renew: boolean;
  source: string;
  source_id: string;
  active: boolean;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** Opaque transaction prepared by AnchorWriter and executed by AnchorSigner. */
export interface AnchorTransaction {
  readonly _type: 'anchor-tx';
  readonly operation: 'upsert' | 'update';
  readonly table: string;
  readonly data: Record<string, unknown>;
  /** Comma-separated conflict columns for upsert. */
  readonly conflictColumns?: string;
  /** Column→value pairs for update match. */
  readonly matchColumns?: Record<string, string>;
}

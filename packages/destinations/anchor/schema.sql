-- Anchor-compatible entitlements table for @doubloon/anchor
-- UNIQUE (product_id, user_wallet) ensures one entitlement per product per user.
-- Re-subscribing upserts (reactivates) the existing row.

CREATE TABLE entitlements (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  TEXT        NOT NULL,
  user_wallet TEXT        NOT NULL,
  slug        TEXT        NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  auto_renew  BOOLEAN     NOT NULL DEFAULT false,
  source      TEXT        NOT NULL,
  source_id   TEXT        NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  revoked_at  TIMESTAMPTZ,
  revoked_by  TEXT,
  UNIQUE (product_id, user_wallet)
);

CREATE INDEX idx_entitlements_wallet  ON entitlements (user_wallet);
CREATE INDEX idx_entitlements_product ON entitlements (product_id);

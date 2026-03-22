/**
 * Supported blockchain networks.
 */
export type Chain = 'solana' | 'evm';

/**
 * Supported payment stores/sources.
 */
export type Store = 'apple' | 'google' | 'stripe' | 'x402';

/**
 * How an entitlement was created. Maps to u8 on-chain.
 */
export type EntitlementSource = 'platform' | 'creator' | 'delegate' | 'apple' | 'google' | 'stripe' | 'x402';

/**
 * Normalized notification types across all stores.
 */
export type NotificationType =
  | 'initial_purchase'
  | 'renewal'
  | 'cancellation'
  | 'uncancellation'
  | 'expiration'
  | 'refund'
  | 'revocation'
  | 'billing_recovery'
  | 'billing_retry_start'
  | 'grace_period_start'
  | 'price_increase_consent'
  | 'offer_redeemed'
  | 'plan_change'
  | 'pause'
  | 'resume'
  | 'test';

/**
 * Platform singleton state. Maps to the Platform PDA/contract state.
 */
export interface Platform {
  /** The wallet with super-admin privileges. Base58 (Solana) or 0x-prefixed (EVM). */
  readonly authority: string;
  /** Total number of products registered on this platform. */
  readonly productCount: number;
  /** Emergency kill switch. If true, no mints/updates allowed globally. */
  readonly frozen: boolean;
}

/**
 * A product registered on-chain. Maps to the Product PDA/contract state.
 */
export interface Product {
  /** The wallet that registered this product. */
  readonly creator: string;
  /** Unique product identifier. 64-char hex string (32 bytes). SHA-256 of slug. */
  readonly productId: string;
  /** Human-readable product name. Max 64 UTF-8 bytes. */
  readonly name: string;
  /** URI pointing to off-chain metadata JSON. Max 200 UTF-8 bytes. */
  readonly metadataUri: string;
  /** When the product was registered. */
  readonly createdAt: Date;
  /** When the product was last updated. */
  readonly updatedAt: Date;
  /** If false, no new entitlements can be minted. Existing entitlements remain valid. */
  readonly active: boolean;
  /** Platform-level freeze. Only platform authority can set/unset. */
  readonly frozen: boolean;
  /** Number of entitlements minted for this product (ever, not just active). */
  readonly entitlementCount: number;
  /** Number of active delegates for this product. */
  readonly delegateCount: number;
  /** Default entitlement duration in seconds. 0 = lifetime. */
  readonly defaultDuration: number;
}

/**
 * A delegation granting minting rights for a product to another wallet.
 */
export interface MintDelegate {
  /** Which product this delegation is for. 64-char hex string. */
  readonly productId: string;
  /** The wallet granted minting rights. */
  readonly delegate: string;
  /** Who granted the delegation (product creator or platform authority). */
  readonly grantedBy: string;
  /** When the delegation was granted. */
  readonly grantedAt: Date;
  /** When the delegation expires. null = no expiry. */
  readonly expiresAt: Date | null;
  /** Maximum number of entitlements this delegate can mint. 0 = unlimited. */
  readonly maxMints: number;
  /** Number of entitlements minted by this delegate. */
  readonly mintsUsed: number;
  /** If false, delegation is revoked. */
  readonly active: boolean;
}

/**
 * An on-chain entitlement record granting a wallet access to a product.
 */
export interface Entitlement {
  /** Which product this entitlement is for. 64-char hex string. */
  readonly productId: string;
  /** The wallet that holds this entitlement. */
  readonly user: string;
  /** When the entitlement was first granted. */
  readonly grantedAt: Date;
  /** When the entitlement expires. null = lifetime access. */
  readonly expiresAt: Date | null;
  /** Hint: does the underlying store subscription auto-renew? Not used for access control. */
  readonly autoRenew: boolean;
  /** How this entitlement was created. */
  readonly source: EntitlementSource;
  /** Store transaction ID or other identifier from the payment source. */
  readonly sourceId: string;
  /** If false, the entitlement is revoked regardless of expiresAt. */
  readonly active: boolean;
  /** When the entitlement was revoked. null = not revoked. */
  readonly revokedAt: Date | null;
  /** Who revoked the entitlement. null if not revoked. */
  readonly revokedBy: string | null;
}

/**
 * Result of checking a single entitlement.
 */
export interface EntitlementCheck {
  /** Whether the user is currently entitled. */
  readonly entitled: boolean;
  /** The raw entitlement data, or null if not found. */
  readonly entitlement: Entitlement | null;
  /** Reason for the check result. */
  readonly reason: 'active' | 'not_found' | 'expired' | 'revoked';
  /** When the entitlement expires. null = lifetime or not entitled. Cache TTL hint. */
  readonly expiresAt: Date | null;
  /** Product metadata (populated by caller if needed). */
  readonly product: Product | null;
}

/**
 * Result of checking multiple entitlements for one user.
 */
export interface EntitlementCheckBatch {
  /** Results keyed by productId. */
  readonly results: Record<string, EntitlementCheck>;
  /** The user wallet that was checked. */
  user: string;
  /** When the check was performed. */
  readonly checkedAt: Date;
}

/**
 * Instruction to mint or extend an on-chain entitlement.
 */
export interface MintInstruction {
  /** On-chain product ID (64-char hex). */
  readonly productId: string;
  /** Wallet to receive the entitlement. */
  readonly user: string;
  /** When the entitlement should expire. null = lifetime. */
  readonly expiresAt: Date | null;
  /** Payment source. */
  readonly source: EntitlementSource;
  /** Store-specific transaction ID for audit trail. */
  readonly sourceId: string;
}

/**
 * Instruction to revoke an on-chain entitlement.
 */
export interface RevokeInstruction {
  /** On-chain product ID (64-char hex). */
  readonly productId: string;
  /** Wallet whose entitlement should be revoked. */
  readonly user: string;
  /** Reason for revocation (for logging/audit). */
  readonly reason: string;
}

/**
 * A normalized store notification event.
 */
export interface StoreNotification {
  /** Unique notification/transaction ID from the store. */
  readonly id: string;
  /** Normalized notification type. */
  readonly type: NotificationType;
  /** Which store sent this notification. */
  readonly store: Store;
  /** 'production' or 'sandbox'. */
  readonly environment: string;
  /** On-chain product ID (after resolution from store SKU). */
  readonly productId: string;
  /** User wallet address (after resolution from store user ID). */
  readonly userWallet: string;
  /** Original transaction ID (for subscription grouping). */
  readonly originalTransactionId: string;
  /** When the entitlement expires according to the store. null = lifetime/non-subscription. */
  readonly expiresAt: Date | null;
  /** Whether the subscription auto-renews. */
  readonly autoRenew: boolean;
  /** When the store generated this event. */
  readonly storeTimestamp: Date;
  /** When our server received this event. */
  readonly receivedTimestamp: Date;
  /** Deterministic key for deduplication. */
  readonly deduplicationKey: string;
  /** Raw store payload for debugging. */
  readonly raw: unknown;
}

/**
 * Store-specific SKU mapping for a product.
 */
export interface ProductStoreMapping {
  readonly apple?: {
    readonly productIds: readonly string[];
    readonly subscriptionGroupId?: string;
  };
  readonly google?: {
    readonly productIds: readonly string[];
    readonly basePlanIds?: readonly string[];
  };
  readonly stripe?: {
    readonly priceIds: readonly string[];
  };
  readonly x402?: {
    readonly priceUsd: number;
    readonly durationSeconds: number;
  };
}

/**
 * Off-chain product metadata JSON structure.
 */
export interface ProductMetadata {
  readonly productId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly images: {
    readonly icon?: string;
    readonly banner?: string;
    readonly screenshots?: readonly string[];
  };
  readonly pricing: {
    readonly currency: string;
    readonly amount: number;
    readonly interval?: 'day' | 'week' | 'month' | 'year';
    readonly intervalCount?: number;
    readonly trialDays?: number;
  };
  readonly storeBindings: ProductStoreMapping;
  readonly features?: readonly string[];
  readonly config?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

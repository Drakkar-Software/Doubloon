import type { Entitlement, Product, MintDelegate, Platform, EntitlementSource } from '@doubloon/core';

const KEY_SEP = '\0';

/**
 * In-memory storage backing the local chain provider.
 * Shared between reader and writer to simulate on-chain state.
 */
export class LocalChainStore {
  readonly #entitlements = new Map<string, Entitlement>();
  readonly #products = new Map<string, Product>();
  readonly #delegates = new Map<string, MintDelegate>();
  #platform: Platform;
  #txCounter = 0;

  constructor(platform?: Partial<Platform>) {
    this.#platform = {
      authority: platform?.authority ?? 'local-authority',
      productCount: platform?.productCount ?? 0,
      frozen: platform?.frozen ?? false,
    };
  }

  // --- Keys ---

  static entitlementKey(productId: string, user: string): string {
    return `${productId}${KEY_SEP}${user}`;
  }

  static delegateKey(productId: string, delegate: string): string {
    return `${productId}${KEY_SEP}delegate${KEY_SEP}${delegate}`;
  }

  // --- Platform ---

  getPlatform(): Platform {
    return { ...this.#platform };
  }

  // --- Products ---

  getProduct(productId: string): Product | null {
    return this.#products.get(productId) ?? null;
  }

  getAllProducts(): Product[] {
    return [...this.#products.values()];
  }

  registerProduct(params: {
    productId: string;
    name: string;
    metadataUri: string;
    defaultDuration: number;
    creator: string;
  }): Product {
    const existing = this.#products.get(params.productId);
    const now = new Date();
    const product: Product = {
      creator: params.creator,
      productId: params.productId,
      name: params.name,
      metadataUri: params.metadataUri,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      active: true,
      frozen: false,
      entitlementCount: existing?.entitlementCount ?? 0,
      delegateCount: existing?.delegateCount ?? 0,
      defaultDuration: params.defaultDuration,
    };
    this.#products.set(params.productId, product);

    // Only increment count for new products
    if (!existing) {
      this.#platform = {
        ...this.#platform,
        productCount: this.#platform.productCount + 1,
      };
    }
    return product;
  }

  /**
   * Set a product's active flag. Inactive products reject new mints.
   */
  setProductActive(productId: string, active: boolean): void {
    const product = this.#products.get(productId);
    if (!product) return;
    this.#products.set(productId, { ...product, active, updatedAt: new Date() });
  }

  /**
   * Set a product's frozen flag. Frozen products reject new mints.
   */
  setProductFrozen(productId: string, frozen: boolean): void {
    const product = this.#products.get(productId);
    if (!product) return;
    this.#products.set(productId, { ...product, frozen, updatedAt: new Date() });
  }

  // --- Entitlements ---

  getEntitlement(productId: string, user: string): Entitlement | null {
    return this.#entitlements.get(LocalChainStore.entitlementKey(productId, user)) ?? null;
  }

  getAllEntitlements(): Entitlement[] {
    return [...this.#entitlements.values()];
  }

  getUserEntitlements(user: string): Entitlement[] {
    return [...this.#entitlements.values()].filter((e) => e.user === user);
  }

  mintEntitlement(params: {
    productId: string;
    user: string;
    expiresAt: Date | null;
    source: EntitlementSource;
    sourceId: string;
    autoRenew?: boolean;
  }): { entitlement: Entitlement; txHash: string } {
    const key = LocalChainStore.entitlementKey(params.productId, params.user);
    const existing = this.#entitlements.get(key);

    const entitlement: Entitlement = {
      productId: params.productId,
      user: params.user,
      grantedAt: existing?.grantedAt ?? new Date(),
      expiresAt: params.expiresAt,
      autoRenew: params.autoRenew ?? false,
      source: params.source,
      sourceId: params.sourceId,
      active: true,
      revokedAt: null,
      revokedBy: null,
    };

    this.#entitlements.set(key, entitlement);

    // Update product entitlement count if this is a new entitlement
    if (!existing) {
      const product = this.#products.get(params.productId);
      if (product) {
        this.#products.set(params.productId, {
          ...product,
          entitlementCount: product.entitlementCount + 1,
          updatedAt: new Date(),
        });
      }
    }

    const txHash = this.#nextTxHash();
    return { entitlement, txHash };
  }

  revokeEntitlement(params: {
    productId: string;
    user: string;
    revokedBy: string;
  }): { entitlement: Entitlement; txHash: string } | null {
    const key = LocalChainStore.entitlementKey(params.productId, params.user);
    const existing = this.#entitlements.get(key);
    if (!existing) return null;

    const revoked: Entitlement = {
      ...existing,
      active: false,
      revokedAt: new Date(),
      revokedBy: params.revokedBy,
    };
    this.#entitlements.set(key, revoked);

    return { entitlement: revoked, txHash: this.#nextTxHash() };
  }

  // --- Delegates ---

  getDelegate(productId: string, delegate: string): MintDelegate | null {
    return this.#delegates.get(LocalChainStore.delegateKey(productId, delegate)) ?? null;
  }

  grantDelegation(params: {
    productId: string;
    delegate: string;
    grantedBy: string;
    expiresAt: Date | null;
    maxMints: number;
  }): MintDelegate {
    const d: MintDelegate = {
      productId: params.productId,
      delegate: params.delegate,
      grantedBy: params.grantedBy,
      grantedAt: new Date(),
      expiresAt: params.expiresAt,
      maxMints: params.maxMints,
      mintsUsed: 0,
      active: true,
    };
    this.#delegates.set(LocalChainStore.delegateKey(params.productId, params.delegate), d);
    return d;
  }

  // --- Utilities ---

  clear(): void {
    this.#entitlements.clear();
    this.#products.clear();
    this.#delegates.clear();
    this.#platform = { authority: this.#platform.authority, productCount: 0, frozen: false };
    this.#txCounter = 0;
  }

  get entitlementCount(): number {
    return this.#entitlements.size;
  }

  get productCount(): number {
    return this.#products.size;
  }

  #nextTxHash(): string {
    this.#txCounter++;
    return `0xlocal${this.#txCounter.toString(16).padStart(60, '0')}`;
  }
}

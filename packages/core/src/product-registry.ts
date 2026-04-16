import { deriveProductIdHex, validateSlug } from './product-id.js';
import { DoubloonError } from './errors.js';

export interface ProductRegistryEntry {
  slug: string;
  /** 64-char hex string (SHA-256 of slug). */
  productId: string;
  name: string;
  /** Entitlement duration in seconds. 0 = lifetime. */
  defaultDuration: number;
}

export interface ProductRegistry {
  /** Get slug for a productId. Throws PRODUCT_NOT_MAPPED if not found. */
  getSlug(productId: string): string;
  /** Get productId for a slug. Throws PRODUCT_NOT_MAPPED if not found. */
  getProductId(slug: string): string;
  getEntry(productId: string): ProductRegistryEntry | null;
  getEntryBySlug(slug: string): ProductRegistryEntry | null;
  entries(): ProductRegistryEntry[];
  readonly size: number;
}

/**
 * Build a bidirectional slug<->productId registry.
 *
 * Starfish stores feature slugs; Doubloon operates on 64-char hex productIds.
 * This registry bridges the two representations.
 *
 * @throws DoubloonError('INVALID_SLUG') if any slug fails validation or is duplicated
 */
export function createProductRegistry(
  products: ReadonlyArray<{ slug: string; name: string; defaultDuration: number }>,
): ProductRegistry {
  const byProductId = new Map<string, ProductRegistryEntry>();
  const bySlug = new Map<string, ProductRegistryEntry>();

  for (const p of products) {
    validateSlug(p.slug); // throws DoubloonError('INVALID_SLUG') if invalid
    if (bySlug.has(p.slug)) {
      throw new DoubloonError('INVALID_SLUG', `Duplicate slug: "${p.slug}"`);
    }
    const productId = deriveProductIdHex(p.slug);
    const entry: ProductRegistryEntry = { slug: p.slug, productId, name: p.name, defaultDuration: p.defaultDuration };
    byProductId.set(productId, entry);
    bySlug.set(p.slug, entry);
  }

  return {
    getSlug(productId: string): string {
      const entry = byProductId.get(productId);
      if (!entry) throw new DoubloonError('PRODUCT_NOT_MAPPED', `Unknown productId: ${productId}`);
      return entry.slug;
    },
    getProductId(slug: string): string {
      const entry = bySlug.get(slug);
      if (!entry) throw new DoubloonError('PRODUCT_NOT_MAPPED', `Unknown slug: ${slug}`);
      return entry.productId;
    },
    getEntry(productId: string): ProductRegistryEntry | null {
      return byProductId.get(productId) ?? null;
    },
    getEntryBySlug(slug: string): ProductRegistryEntry | null {
      return bySlug.get(slug) ?? null;
    },
    entries(): ProductRegistryEntry[] {
      return Array.from(byProductId.values());
    },
    get size(): number {
      return byProductId.size;
    },
  };
}

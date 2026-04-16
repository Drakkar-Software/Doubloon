import type { Logger } from '@doubloon/core';
import { DoubloonError } from '@doubloon/core';
import { createProductRegistry } from '@doubloon/core';
import type { ProductRegistry } from '@doubloon/core';
import type { ServerConfig } from './server.js';
import type { MintRetryOpts } from './mint-retry.js';
import type { DedupStore } from './dedup.js';
import type { RateLimiterConfig } from './rate-limiter.js';

export type { ProductRegistry };

export interface DoubloonProductConfig {
  slug: string;
  name: string;
  /** Entitlement duration in seconds. 0 = lifetime. */
  defaultDuration: number;
}

/**
 * Duck-typed destination — accepts StarfishDestination, LocalChain, or any
 * object satisfying ChainReader/Writer/Signer interfaces.
 *
 * When the destination also exposes a `store` with a `registerProduct` method
 * (i.e. LocalChain), defineConfig auto-registers all configured products.
 */
export interface DestinationLike {
  reader: ServerConfig['chain']['reader'];
  writer: ServerConfig['chain']['writer'];
  signer: ServerConfig['chain']['signer'];
  /** Present on LocalChain. Used for auto-registering products. */
  store?: unknown;
}

export interface DoubloonConfig {
  products: DoubloonProductConfig[];
  /**
   * Entitlement destination. Pass createStarfishDestination() or createLocalChain()
   * directly — defineConfig auto-registers products on local stores.
   */
  destination: DestinationLike;
  bridges?: ServerConfig['bridges'];
  hooks?: {
    beforeMint?: ServerConfig['beforeMint'];
    afterMint?: ServerConfig['afterMint'];
    afterRevoke?: ServerConfig['afterRevoke'];
    onAcknowledgmentRequired?: ServerConfig['onAcknowledgmentRequired'];
  };
  onMintFailure: ServerConfig['onMintFailure'];
  mintRetry?: MintRetryOpts;
  dedup?: DedupStore;
  rateLimiter?: RateLimiterConfig | false;
  logger?: Logger;
}

export interface DoubloonConfigResult {
  serverConfig: ServerConfig;
  registry: ProductRegistry;
}

/**
 * Declarative Doubloon server configuration.
 *
 * Derives product IDs from slugs, auto-registers products on local stores,
 * and assembles a fully wired ServerConfig for createServer().
 *
 * @example
 * ```ts
 * // Starfish destination (production)
 * import { createStarfishDestination } from '@doubloon/starfish';
 * const dest = createStarfishDestination({ client, products, signerKey: 'admin' });
 * const { serverConfig } = defineConfig({ products, destination: dest, onMintFailure });
 *
 * // Local destination (dev/test)
 * import { createLocalChain } from '@doubloon/chain-local';
 * const { serverConfig } = defineConfig({
 *   products,
 *   destination: createLocalChain(),  // products auto-registered on store
 *   onMintFailure,
 * });
 * ```
 */
export function defineConfig(config: DoubloonConfig): DoubloonConfigResult {
  if (!config.products.length) {
    throw new DoubloonError('MISSING_CREDENTIALS', 'defineConfig: at least one product required');
  }

  const registry = createProductRegistry(config.products);

  // Auto-register products on local chain stores (duck-typed via store.registerProduct)
  const { store } = config.destination;
  if (store !== undefined && store !== null && typeof store === 'object') {
    const s = store as Record<string, unknown>;
    if (typeof s['registerProduct'] === 'function' && typeof s['getProduct'] === 'function') {
      for (const entry of registry.entries()) {
        if ((s['getProduct'] as (id: string) => unknown)(entry.productId) === null) {
          (s['registerProduct'] as (p: object) => void)({
            productId: entry.productId,
            name: entry.name,
            metadataUri: '',
            defaultDuration: entry.defaultDuration,
            creator: 'doubloon-config',
          });
        }
      }
    }
  }

  const serverConfig: ServerConfig = {
    chain: {
      reader: config.destination.reader,
      writer: config.destination.writer,
      signer: config.destination.signer,
    },
    bridges: config.bridges ?? {},
    onMintFailure: config.onMintFailure,
    beforeMint: config.hooks?.beforeMint,
    afterMint: config.hooks?.afterMint,
    afterRevoke: config.hooks?.afterRevoke,
    onAcknowledgmentRequired: config.hooks?.onAcknowledgmentRequired,
    mintRetry: config.mintRetry,
    dedup: config.dedup,
    rateLimiter: config.rateLimiter,
    logger: config.logger,
  };

  return { serverConfig, registry };
}

import type { Logger, Destination, Bridge } from '@drakkar.software/doubloon-core';
import { DoubloonError } from '@drakkar.software/doubloon-core';
import { createProductRegistry } from '@drakkar.software/doubloon-core';
import type { ProductRegistry } from '@drakkar.software/doubloon-core';
import type { ServerConfig } from './server.js';
import type { MintRetryOpts } from './mint-retry.js';
import type { DedupStore } from './dedup.js';
import type { RateLimiterConfig } from './rate-limiter.js';

export type { ProductRegistry, Destination, Bridge };

export interface DoubloonProductConfig {
  slug: string;
  name: string;
  /** Entitlement duration in seconds. 0 = lifetime. */
  defaultDuration: number;
}

/**
 * Generic destination — any backend implementing the core Destination interface.
 * Pass the result of createStarfishDestination() or a custom backend.
 * @alias Destination
 */
export type DestinationLike = Destination;

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
  /**
   * Shared webhook secret. When set, every incoming webhook must include the
   * matching value in the `x-doubloon-secret` header.
   */
  webhookSecret?: string;
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
 * import { createStarfishDestination } from '@drakkar.software/doubloon-starfish';
 * const dest = createStarfishDestination({ client, products, signerKey: 'admin' });
 * const { serverConfig, registry } = defineConfig({
 *   products,
 *   destination: dest,
 *   onMintFailure: async (instr, err) => console.error(err),
 * });
 * const server = createServer(serverConfig);
 * ```
 */
export function defineConfig(config: DoubloonConfig): DoubloonConfigResult {
  if (!config.products.length) {
    throw new DoubloonError('MISSING_CREDENTIALS', 'defineConfig: at least one product required');
  }

  const registry = createProductRegistry(config.products);

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
    webhookSecret: config.webhookSecret,
    logger: config.logger,
  };

  return { serverConfig, registry };
}

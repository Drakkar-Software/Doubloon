import type { Logger, Destination } from '@drakkar.software/doubloon-core';
import type { StarfishClient } from '@drakkar.software/starfish-client';
import { createProductRegistry } from './product-registry.js';
import type { ProductRegistry } from './product-registry.js';
import { StarfishReader } from './reader.js';
import { StarfishWriter } from './writer.js';
import { StarfishSigner } from './signer.js';

export interface StarfishDestinationConfig {
  client: StarfishClient;
  products: ReadonlyArray<{ slug: string; name: string; defaultDuration: number }>;
  /**
   * Identity string for the signer (admin identity on the Starfish server).
   * Used as the `signer` field in mint/revoke instructions.
   */
  signerKey: string;
  /**
   * Storage path template. `{user}` is replaced with the wallet address.
   * Default: `"users/{user}/entitlements"`
   */
  storagePath?: string;
  /** Field in document data holding feature slugs. Default: `"features"` */
  field?: string;
  logger?: Logger;
}

/** Starfish-backed entitlement destination. Implements the core Destination interface. */
export interface StarfishDestination extends Destination {
  reader: StarfishReader;
  writer: StarfishWriter;
  signer: StarfishSigner;
  registry: ProductRegistry;
}

/**
 * Create a complete Starfish entitlement destination.
 *
 * Usage with the Doubloon server:
 * ```ts
 * const dest = createStarfishDestination({
 *   client: new StarfishClient({ baseUrl: 'https://my-starfish.example.com' }),
 *   products: [{ slug: 'pro-monthly', name: 'Pro Monthly', defaultDuration: 2592000 }],
 *   signerKey: 'server-admin',
 * });
 *
 * const server = createServer({
 *   chain: { reader: dest.reader, writer: dest.writer, signer: dest.signer },
 *   // ...
 * });
 * ```
 */
export function createStarfishDestination(config: StarfishDestinationConfig): StarfishDestination {
  const registry = createProductRegistry(config.products);
  const sharedConfig = {
    client: config.client,
    registry,
    storagePath: config.storagePath,
    field: config.field,
    logger: config.logger,
  };
  return {
    reader: new StarfishReader(sharedConfig),
    writer: new StarfishWriter(sharedConfig),
    signer: new StarfishSigner({ client: config.client, publicKey: config.signerKey, logger: config.logger }),
    registry,
  };
}

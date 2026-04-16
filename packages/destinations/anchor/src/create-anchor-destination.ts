import type { Destination, Logger } from '@doubloon/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createProductRegistry } from './product-registry.js';
import type { ProductRegistry } from './product-registry.js';
import { AnchorReader } from './reader.js';
import { AnchorWriter } from './writer.js';
import { AnchorSigner } from './signer.js';

export interface AnchorDestinationConfig {
  supabase: SupabaseClient;
  products: ReadonlyArray<{ slug: string; name: string; defaultDuration: number }>;
  /**
   * Identity string for the signer (admin identity / service role label).
   * Used as the `signer` field in mint/revoke instructions.
   */
  signerKey: string;
  /** Table name. Default: `"entitlements"` */
  tableName?: string;
  logger?: Logger;
}

/** Supabase-backed entitlement destination. Implements the core Destination interface. */
export interface AnchorDestination extends Destination {
  reader: AnchorReader;
  writer: AnchorWriter;
  signer: AnchorSigner;
  registry: ProductRegistry;
}

/**
 * Create a complete Supabase entitlement destination.
 *
 * Usage with the Doubloon server:
 * ```ts
 * import { createClient } from '@supabase/supabase-js';
 * import { createAnchorDestination } from '@doubloon/anchor';
 *
 * const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
 *
 * const dest = createAnchorDestination({
 *   supabase,
 *   products: [{ slug: 'pro-monthly', name: 'Pro Monthly', defaultDuration: 2592000 }],
 *   signerKey: 'service-role',
 * });
 *
 * const { serverConfig } = defineConfig({
 *   products: dest.registry.entries(),
 *   destination: dest,
 *   // ...
 * });
 * ```
 */
export function createAnchorDestination(config: AnchorDestinationConfig): AnchorDestination {
  const registry = createProductRegistry(config.products);
  const sharedConfig = {
    registry,
    tableName: config.tableName,
    logger: config.logger,
  };
  return {
    reader: new AnchorReader({ supabase: config.supabase, ...sharedConfig }),
    writer: new AnchorWriter(sharedConfig),
    signer: new AnchorSigner({ supabase: config.supabase, publicKey: config.signerKey, logger: config.logger }),
    registry,
  };
}

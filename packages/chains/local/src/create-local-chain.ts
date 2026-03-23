import type { Logger } from '@doubloon/core';
import { LocalChainStore } from './store.js';
import { LocalChainReader } from './reader.js';
import { LocalChainWriter } from './writer.js';
import { LocalChainSigner } from './signer.js';

export interface LocalChainConfig {
  /** Authority/admin wallet address. Defaults to 'local-authority'. */
  authority?: string;
  /** Signer public key. Defaults to 'local-signer'. */
  signerKey?: string;
  logger?: Logger;
}

export interface LocalChain {
  /** The shared in-memory store. Access for inspection/seeding in tests. */
  store: LocalChainStore;
  /** Reader compatible with ServerConfig.chain.reader. */
  reader: LocalChainReader;
  /** Writer compatible with ServerConfig.chain.writer (ChainWriter). */
  writer: LocalChainWriter;
  /** Signer compatible with ServerConfig.chain.signer (ChainSigner). */
  signer: LocalChainSigner;
}

/**
 * Creates a complete local chain provider backed by in-memory storage.
 *
 * Usage with the Doubloon server:
 * ```ts
 * const local = createLocalChain();
 * const server = createServer({
 *   chain: {
 *     reader: local.reader,
 *     writer: local.writer,
 *     signer: local.signer,
 *   },
 *   // ...
 * });
 * ```
 */
export function createLocalChain(config?: LocalChainConfig): LocalChain {
  const store = new LocalChainStore({ authority: config?.authority });
  const reader = new LocalChainReader({ store, logger: config?.logger });
  const writer = new LocalChainWriter({ store, logger: config?.logger });
  const signer = new LocalChainSigner({
    publicKey: config?.signerKey,
    logger: config?.logger,
  });
  return { store, reader, writer, signer };
}

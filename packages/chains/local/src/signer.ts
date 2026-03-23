import type { Logger } from '@doubloon/core';
import { nullLogger } from '@doubloon/core';

export interface LocalChainSignerConfig {
  publicKey?: string;
  logger?: Logger;
}

/**
 * No-op signer that returns deterministic fake transaction signatures.
 * Implements the ChainSigner interface expected by the Doubloon server.
 */
export class LocalChainSigner {
  readonly publicKey: string;
  readonly #logger: Logger;
  #sigCounter = 0;

  constructor(config?: LocalChainSignerConfig) {
    this.publicKey = config?.publicKey ?? 'local-signer';
    this.#logger = config?.logger ?? nullLogger;
  }

  async signAndSend(transaction: unknown): Promise<string> {
    this.#sigCounter++;
    const sig = `local-sig-${this.#sigCounter.toString(16).padStart(8, '0')}`;
    this.#logger.debug('signAndSend', { sig, transaction });
    return sig;
  }
}

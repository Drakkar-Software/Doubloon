import type { Logger } from '@drakkar.software/doubloon-core';
import { DoubloonError, nullLogger } from '@drakkar.software/doubloon-core';
import type { StarfishClient } from '@drakkar.software/starfish-client';
import { ConflictError, StarfishHttpError } from '@drakkar.software/starfish-client';
import type { StarfishTransaction } from './writer.js';

export interface StarfishSignerConfig {
  client: StarfishClient;
  /**
   * Identity string used as the signer's "public key".
   * Should match the admin identity on the Starfish server.
   */
  publicKey: string;
  logger?: Logger;
}

/**
 * Executes Starfish push operations — the "signing" step in the mint pipeline.
 *
 * Receives an opaque StarfishTransaction from StarfishWriter and calls
 * `client.push()`. Returns the resulting document hash as the "tx signature".
 *
 * On OCC conflict (409): throws retryable DoubloonError so mintWithRetry
 * re-runs the full writer (pull+modify) + signer (push) cycle with a fresh hash.
 */
export class StarfishSigner {
  readonly #client: StarfishClient;
  readonly #logger: Logger;
  readonly publicKey: string;

  constructor(config: StarfishSignerConfig) {
    this.#client = config.client;
    this.publicKey = config.publicKey;
    this.#logger = config.logger ?? nullLogger;
  }

  async signAndSend(transaction: unknown): Promise<string> {
    const tx = transaction as StarfishTransaction;
    if (tx?._type !== 'starfish-tx') {
      throw new DoubloonError('RPC_ERROR', 'StarfishSigner received unexpected transaction type', {
        retryable: false,
        chain: 'starfish',
      });
    }

    this.#logger.debug('StarfishSigner.signAndSend', { pushPath: tx.pushPath });

    try {
      const result = await this.#client.push(tx.pushPath, tx.data, tx.baseHash);
      return result.hash;
    } catch (err) {
      if (err instanceof ConflictError) {
        // baseHash stale — writer must re-pull on next retry
        throw new DoubloonError('RPC_ERROR', 'Starfish OCC conflict: document modified concurrently', {
          retryable: true,
          chain: 'starfish',
          cause: err,
        });
      }
      throw new DoubloonError('RPC_ERROR', `Starfish push failed: ${String(err)}`, {
        retryable: err instanceof StarfishHttpError ? err.status >= 500 : true,
        chain: 'starfish',
        cause: err instanceof Error ? err : undefined,
      });
    }
  }
}

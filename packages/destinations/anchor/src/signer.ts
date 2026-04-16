import type { Logger } from '@drakkar.software/doubloon-core';
import { DoubloonError, nullLogger } from '@drakkar.software/doubloon-core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnchorTransaction } from './types.js';

export interface AnchorSignerConfig {
  supabase: SupabaseClient;
  /**
   * Identity string used as the signer's "public key".
   * Typically the Supabase service-role key label or admin identity.
   */
  publicKey: string;
  logger?: Logger;
}

/**
 * Executes Supabase write operations — the "signing" step in the mint pipeline.
 *
 * Receives an opaque AnchorTransaction from AnchorWriter and executes it
 * against Supabase. Returns the affected row id as the "tx signature".
 */
export class AnchorSigner {
  readonly #supabase: SupabaseClient;
  readonly #logger: Logger;
  readonly publicKey: string;

  constructor(config: AnchorSignerConfig) {
    this.#supabase = config.supabase;
    this.publicKey = config.publicKey;
    this.#logger = config.logger ?? nullLogger;
  }

  async signAndSend(transaction: unknown): Promise<string> {
    const tx = transaction as AnchorTransaction;
    if (tx?._type !== 'anchor-tx') {
      throw new DoubloonError('RPC_ERROR', 'AnchorSigner received unexpected transaction type', {
        retryable: false,
        chain: 'anchor',
      });
    }

    this.#logger.debug('AnchorSigner.signAndSend', { operation: tx.operation, table: tx.table });

    if (tx.operation === 'upsert') {
      const { data, error } = await this.#supabase
        .from(tx.table)
        .upsert(tx.data, { onConflict: tx.conflictColumns })
        .select('id')
        .single();

      if (error) {
        throw new DoubloonError('RPC_ERROR', `Anchor upsert failed: ${error.message}`, {
          retryable: false,
          chain: 'anchor',
        });
      }

      return (data as { id: string }).id;
    }

    // operation === 'update'
    const matchColumns = tx.matchColumns ?? {};
    let query = this.#supabase.from(tx.table).update(tx.data).select('id');
    for (const [col, val] of Object.entries(matchColumns)) {
      query = query.eq(col, val) as typeof query;
    }

    const { data, error } = await query.single();

    if (error) {
      throw new DoubloonError('RPC_ERROR', `Anchor update failed: ${error.message}`, {
        retryable: false,
        chain: 'anchor',
      });
    }

    return (data as { id: string }).id;
  }
}

import type { Logger, MintInstruction, RevokeInstruction, Entitlement } from '@doubloon/core';
import { nullLogger, isMintInstruction } from '@doubloon/core';
import type { ChainWriter, ChainSigner, MintRetryOpts } from './mint-retry.js';
import { mintWithRetry } from './mint-retry.js';

export interface ReconciliationConfig {
  writer: ChainWriter;
  signer: ChainSigner;
  mintRetry?: MintRetryOpts;
  logger?: Logger;
}

export interface ReconciliationItem {
  subscriptionId: string;
  bridge: {
    reconcile(
      subscriptionId: string,
      currentState: Entitlement | null,
    ): Promise<{
      drift: boolean;
      instruction: MintInstruction | RevokeInstruction | null;
    }>;
  };
  currentState: Entitlement | null;
}

export interface ReconciliationReport {
  checked: number;
  drifted: number;
  minted: number;
  revoked: number;
  errors: Array<{ subscriptionId: string; error: Error }>;
}

/**
 * Create a reconciliation runner for syncing on-chain state with store records.
 * Used for periodic consistency checks and recovery from past gaps.
 *
 * @param config - Configuration with chain writer, signer, and optional retry settings
 * @returns A reconciliation runner with a run method
 */
export function createReconciliationRunner(config: ReconciliationConfig) {
  const logger = config.logger ?? nullLogger;

  /**
   * Run reconciliation across a batch of subscription items.
   * Continues on errors (reports them separately) to process all items.
   *
   * @param items - Items to reconcile (from store with current on-chain state)
   * @returns Report with counts and error details
   */
  async function run(items: ReconciliationItem[]): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      checked: 0,
      drifted: 0,
      minted: 0,
      revoked: 0,
      errors: [],
    };

    for (const item of items) {
      report.checked++;
      try {
        const result = await item.bridge.reconcile(item.subscriptionId, item.currentState);

        if (!result.drift) continue;
        report.drifted++;

        if (!result.instruction) continue;

        if (isMintInstruction(result.instruction)) {
          const mint = result.instruction;
          const mintResult = await mintWithRetry(
            config.writer,
            config.signer,
            mint,
            config.mintRetry,
          );
          if (mintResult.success) {
            report.minted++;
            logger.info('Reconciliation: minted', { subscriptionId: item.subscriptionId });
          }
        } else {
          const revoke = result.instruction;
          if (config.writer.revokeEntitlement) {
            const tx = await config.writer.revokeEntitlement({
              ...revoke,
              signer: config.signer.publicKey,
            });
            await config.signer.signAndSend(tx);
            report.revoked++;
            logger.info('Reconciliation: revoked', { subscriptionId: item.subscriptionId });
          }
        }
      } catch (err) {
        report.errors.push({
          subscriptionId: item.subscriptionId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    return report;
  }

  return { run };
}

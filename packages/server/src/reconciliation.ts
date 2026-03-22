import type { Logger, MintInstruction, RevokeInstruction, Entitlement } from '@doubloon/core';
import { nullLogger } from '@doubloon/core';
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

export function createReconciliationRunner(config: ReconciliationConfig) {
  const logger = config.logger ?? nullLogger;

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

        if ('source' in result.instruction) {
          const mintResult = await mintWithRetry(
            config.writer,
            config.signer,
            result.instruction as MintInstruction,
            config.mintRetry,
          );
          if (mintResult.success) {
            report.minted++;
            logger.info('Reconciliation: minted', { subscriptionId: item.subscriptionId });
          }
        } else {
          report.revoked++;
          logger.info('Reconciliation: revoked', { subscriptionId: item.subscriptionId });
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

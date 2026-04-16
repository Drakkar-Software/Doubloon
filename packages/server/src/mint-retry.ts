import { DoubloonError } from '@drakkar.software/doubloon-core';
import type { MintInstruction, ChainWriter, ChainSigner } from '@drakkar.software/doubloon-core';

export type { ChainWriter, ChainSigner };

export interface MintRetryOpts {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface MintRetryResult {
  success: boolean;
  txSignature?: string;
  retryCount: number;
  lastError?: Error;
}

/**
 * Attempt to mint an entitlement with exponential backoff retry.
 * Non-retryable errors (e.g., PRODUCT_NOT_ACTIVE) are returned immediately.
 * Retryable errors (e.g., RPC_ERROR) are retried up to maxRetries times.
 *
 * @param writer - Chain writer implementation (Solana, EVM, or local)
 * @param signer - Chain signer for transaction signing
 * @param instruction - Mint instruction with product ID, user wallet, and source
 * @param opts - Retry options (maxRetries, baseDelayMs, maxDelayMs)
 * @returns Result with success flag, transaction signature, retry count, and last error
 */
export async function mintWithRetry(
  writer: ChainWriter,
  signer: ChainSigner,
  instruction: MintInstruction,
  opts?: MintRetryOpts,
): Promise<MintRetryResult> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 1000;
  const maxDelay = opts?.maxDelayMs ?? 8000;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const tx = await writer.mintEntitlement({
        ...instruction,
        signer: signer.publicKey,
      });

      const txSignature = await signer.signAndSend(tx);
      return { success: true, txSignature, retryCount: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (err instanceof DoubloonError && !err.retryable) {
        return { success: false, retryCount: attempt + 1, lastError };
      }

      if (attempt < maxRetries - 1) {
        // Exponential backoff with cap to prevent overflow
        const exponent = Math.min(attempt, 30); // 2^30 is very large already
        const delay = Math.min(baseDelay * Math.pow(2, exponent), maxDelay);
        await sleep(delay);
      }
    }
  }

  return { success: false, retryCount: maxRetries, lastError };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

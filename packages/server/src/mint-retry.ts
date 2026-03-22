import { DoubloonError } from '@doubloon/core';
import type { MintInstruction, RevokeInstruction } from '@doubloon/core';

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

export interface ChainWriter {
  mintEntitlement(params: MintInstruction & { signer: string; autoRenew?: boolean }): Promise<unknown>;
  revokeEntitlement?(params: RevokeInstruction & { signer: string }): Promise<unknown>;
}

export interface ChainSigner {
  signAndSend(transaction: unknown): Promise<string>;
  publicKey: string;
}

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
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        await sleep(delay);
      }
    }
  }

  return { success: false, retryCount: maxRetries, lastError };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

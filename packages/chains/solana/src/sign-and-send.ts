import { Connection, Transaction, Keypair, SendTransactionError } from '@solana/web3.js';
import { DoubloonError } from '@doubloon/core';
import type { ErrorCode } from '@doubloon/core';

export interface WalletAdapter {
  publicKey: import('@solana/web3.js').PublicKey | null;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

export interface SignAndSendOpts {
  skipPreflight?: boolean;
  maxRetries?: number;
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

export async function signAndSend(
  connection: Connection,
  transaction: Transaction,
  signer: Keypair | WalletAdapter,
  opts?: SignAndSendOpts,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;

  if (signer instanceof Keypair) {
    transaction.feePayer = signer.publicKey;
    transaction.sign(signer);
  } else {
    if (!signer.publicKey) {
      throw new DoubloonError('AUTHORITY_MISMATCH', 'Wallet not connected');
    }
    transaction.feePayer = signer.publicKey;
    await signer.signTransaction(transaction);
  }

  try {
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: opts?.skipPreflight ?? false,
      maxRetries: opts?.maxRetries ?? 3,
    });

    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      opts?.commitment ?? 'confirmed',
    );

    return signature;
  } catch (err) {
    if (err instanceof SendTransactionError) {
      const anchorError = parseAnchorError(err.logs ?? []);
      if (anchorError) {
        throw new DoubloonError(
          mapAnchorErrorCode(anchorError.code),
          anchorError.message,
          { chain: 'solana', retryable: false, cause: err },
        );
      }
    }
    throw new DoubloonError(
      'TRANSACTION_FAILED',
      `Transaction failed: ${err instanceof Error ? err.message : String(err)}`,
      { chain: 'solana', retryable: true, cause: err instanceof Error ? err : undefined },
    );
  }
}

function parseAnchorError(logs: string[]): { code: number; message: string } | null {
  for (const log of logs) {
    const match = log.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+)/);
    if (match) {
      return { code: parseInt(match[2], 10), message: match[3] };
    }
  }
  return null;
}

function mapAnchorErrorCode(code: number): ErrorCode {
  const map: Record<number, ErrorCode> = {
    6000: 'AUTHORITY_MISMATCH',
    6001: 'PRODUCT_NOT_ACTIVE',
    6002: 'PRODUCT_FROZEN',
    6003: 'PRODUCT_FROZEN',
    6004: 'DELEGATE_EXPIRED',
    6005: 'INVALID_SLUG',
    6006: 'INVALID_SLUG',
    6007: 'INVALID_SLUG',
    6008: 'AUTHORITY_MISMATCH',
    6009: 'AUTHORITY_MISMATCH',
    6010: 'PRODUCT_NOT_ACTIVE',
  };
  return map[code] ?? 'TRANSACTION_FAILED';
}

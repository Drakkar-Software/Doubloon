import type {
  MintInstruction,
  RevokeInstruction,
  StoreNotification,
  EntitlementCheck,
  EntitlementCheckBatch,
  Store,
  Logger,
} from '@doubloon/core';
import { nullLogger } from '@doubloon/core';
import { mintWithRetry } from './mint-retry.js';
import type { ChainWriter, ChainSigner, MintRetryOpts, MintRetryResult } from './mint-retry.js';

export interface ServerConfig {
  chain: {
    reader: {
      checkEntitlement(productId: string, wallet: string): Promise<EntitlementCheck>;
      checkEntitlements(productIds: string[], wallet: string): Promise<EntitlementCheckBatch>;
    };
    writer: ChainWriter;
    signer: ChainSigner;
  };

  bridges: {
    apple?: {
      handleNotification(headers: Record<string, string>, body: Buffer): Promise<{
        notification: StoreNotification;
        instruction: MintInstruction | RevokeInstruction | null;
      }>;
    };
    google?: {
      handleNotification(headers: Record<string, string>, body: Buffer): Promise<{
        notification: StoreNotification;
        instruction: MintInstruction | RevokeInstruction | null;
        requiresAcknowledgment?: boolean;
      }>;
    };
    stripe?: {
      handleNotification(headers: Record<string, string>, body: Buffer): Promise<{
        notification: StoreNotification;
        instruction: MintInstruction | RevokeInstruction | null;
      }>;
    };
    x402?: {
      handleNotification(headers: Record<string, string>, body: Buffer): Promise<{
        notification: StoreNotification;
        instruction: MintInstruction | RevokeInstruction | null;
      }>;
    };
  };

  mintRetry?: MintRetryOpts;

  beforeMint?: (instruction: MintInstruction, notification: StoreNotification) => Promise<boolean>;
  afterMint?: (instruction: MintInstruction, txSignature: string) => Promise<void>;
  afterRevoke?: (instruction: RevokeInstruction, txSignature: string) => Promise<void>;
  onAcknowledgmentRequired?: (purchaseToken: string, deadline: Date) => Promise<void>;

  onMintFailure: (
    instruction: MintInstruction,
    error: Error,
    context: { store: Store; retryCount: number; willStoreRetry: boolean },
  ) => Promise<void>;

  isDuplicate?: (key: string) => Promise<boolean>;
  markProcessed?: (key: string) => Promise<void>;

  logger?: Logger;
}

export function createServer(config: ServerConfig) {
  const logger = config.logger ?? nullLogger;

  function detectStore(req: {
    headers: Record<string, string>;
    body: Buffer | string;
  }): Store | null {
    if (req.headers['stripe-signature']) return 'stripe';

    const bodyStr = typeof req.body === 'string' ? req.body : req.body.toString('utf-8');
    try {
      const parsed = JSON.parse(bodyStr);
      if (parsed.message?.data) return 'google';
    } catch { /* not JSON */ }

    if (bodyStr.startsWith('eyJ') || bodyStr.startsWith('{"signedPayload"')) return 'apple';

    return null;
  }

  async function handleWebhook(req: {
    headers: Record<string, string>;
    body: Buffer | string;
  }): Promise<{ status: number; body?: string }> {
    const store = detectStore(req);
    logger.info('Webhook received', { store });

    switch (store) {
      case 'apple':
        return handleStoreWebhook('apple', config.bridges.apple, req);
      case 'google':
        return handleStoreWebhook('google', config.bridges.google, req);
      case 'stripe':
        return handleStoreWebhook('stripe', config.bridges.stripe, req);
      default:
        return { status: 400, body: 'Unknown store' };
    }
  }

  async function handleStoreWebhook(
    store: Store,
    bridge: ServerConfig['bridges'][keyof ServerConfig['bridges']],
    req: { headers: Record<string, string>; body: Buffer | string },
  ): Promise<{ status: number }> {
    if (!bridge) return { status: 404 };

    try {
      const body = typeof req.body === 'string' ? Buffer.from(req.body) : req.body;
      const result = await bridge.handleNotification(req.headers, body);

      // Deduplication
      if (
        config.isDuplicate &&
        (await config.isDuplicate(result.notification.deduplicationKey))
      ) {
        logger.info('Duplicate notification, skipping', {
          key: result.notification.deduplicationKey,
        });
        return { status: 200 };
      }

      // Process instruction
      if (result.instruction) {
        await processInstruction(result.instruction, result.notification, store);
      }

      // Google acknowledgment
      if (
        store === 'google' &&
        'requiresAcknowledgment' in result &&
        result.requiresAcknowledgment &&
        config.onAcknowledgmentRequired
      ) {
        const purchaseToken = result.notification.originalTransactionId || result.notification.id;
        await config.onAcknowledgmentRequired(purchaseToken, new Date(Date.now() + 3 * 86400000));
      }

      // Mark as processed
      if (config.markProcessed) {
        await config.markProcessed(result.notification.deduplicationKey);
      }

      return { status: 200 };
    } catch (err) {
      logger.error('Webhook processing failed', { store, error: err });
      return { status: 500 };
    }
  }

  async function processInstruction(
    instruction: MintInstruction | RevokeInstruction,
    notification: StoreNotification,
    store: Store,
  ): Promise<void> {
    if ('source' in instruction) {
      const mint = instruction as MintInstruction;

      if (config.beforeMint) {
        const allowed = await config.beforeMint(mint, notification);
        if (!allowed) {
          logger.info('Mint rejected by beforeMint hook', {
            productId: mint.productId,
            user: mint.user,
          });
          return;
        }
      }

      const result = await mintWithRetry(
        config.chain.writer,
        config.chain.signer,
        mint,
        config.mintRetry,
      );

      if (result.success) {
        logger.info('Entitlement minted', {
          productId: mint.productId,
          user: mint.user,
          tx: result.txSignature,
        });
        if (config.afterMint) await config.afterMint(mint, result.txSignature!);
      } else {
        logger.error('Mint failed after all retries', {
          productId: mint.productId,
          user: mint.user,
        });
        await config.onMintFailure(mint, result.lastError!, {
          store,
          retryCount: result.retryCount,
          willStoreRetry: store !== 'x402',
        });
      }
    } else {
      const revoke = instruction as RevokeInstruction;
      try {
        if (config.chain.writer.revokeEntitlement) {
          const tx = await config.chain.writer.revokeEntitlement({
            ...revoke,
            signer: config.chain.signer.publicKey,
          });
          const txSignature = await config.chain.signer.signAndSend(tx);
          logger.info('Entitlement revoked', {
            productId: revoke.productId,
            user: revoke.user,
            tx: txSignature,
          });
          if (config.afterRevoke) await config.afterRevoke(revoke, txSignature);
        } else {
          logger.warn('Revoke not supported by chain writer', {
            productId: revoke.productId,
            user: revoke.user,
          });
        }
      } catch (err) {
        logger.error('Revoke failed', {
          productId: revoke.productId,
          user: revoke.user,
          error: err,
        });
      }
    }
  }

  async function checkEntitlement(
    productId: string,
    wallet: string,
  ): Promise<EntitlementCheck> {
    return config.chain.reader.checkEntitlement(productId, wallet);
  }

  async function checkEntitlements(
    productIds: string[],
    wallet: string,
  ): Promise<EntitlementCheckBatch> {
    return config.chain.reader.checkEntitlements(productIds, wallet);
  }

  return {
    handleWebhook,
    checkEntitlement,
    checkEntitlements,
    detectStore,
    processInstruction,
  };
}

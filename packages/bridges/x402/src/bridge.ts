import type { MintInstruction, StoreNotification } from '@doubloon/core';
import { nullLogger } from '@doubloon/core';
import { mapX402PaymentType, computeX402DeduplicationKey } from './notification-map.js';
import type { X402BridgeResult, X402BridgeConfig } from './types.js';

/**
 * Parsed x402 payment receipt.
 */
interface X402PaymentReceipt {
  /** Unique payment identifier from the facilitator. */
  paymentId: string;
  /** The wallet address extracted from the payment signature. */
  wallet: string;
  /** The product identifier included in the payment request. */
  productId: string;
  /** Amount paid in USD (or smallest unit). */
  amountUsd: number;
  /** Duration of access in seconds. */
  durationSeconds: number;
  /** Timestamp of the payment (epoch ms). */
  timestamp: number;
  /** Raw facilitator response for auditing. */
  raw?: unknown;
}

/**
 * x402 payment protocol bridge.
 *
 * Handles HTTP 402 Payment Required flows. The wallet address is
 * extracted directly from the payment signature — no WalletResolver needed.
 */
export class X402Bridge {
  private readonly config: X402BridgeConfig;
  private readonly logger: import('@doubloon/core').Logger;

  constructor(config: X402BridgeConfig) {
    this.config = config;
    this.logger = config.logger ?? nullLogger;
  }

  /**
   * Verify a payment receipt from the x402 facilitator and produce
   * a mint instruction for the on-chain entitlement.
   */
  async verifyAndMint(receipt: X402PaymentReceipt): Promise<X402BridgeResult> {
    const notificationType = mapX402PaymentType();

    // Resolve the on-chain product ID from the receipt's product identifier
    const onChainProductId = await this.config.productResolver.resolveProductId(
      'x402',
      receipt.productId,
    );
    if (!onChainProductId) {
      throw new Error(`Unknown x402 product ID: ${receipt.productId}`);
    }

    const deduplicationKey = computeX402DeduplicationKey(
      receipt.paymentId,
      receipt.wallet,
    );

    const now = new Date();
    const expiresAt = receipt.durationSeconds > 0
      ? new Date(receipt.timestamp + receipt.durationSeconds * 1000)
      : null;

    const notification: StoreNotification = {
      id: receipt.paymentId,
      type: notificationType,
      store: 'x402',
      environment: 'production',
      productId: onChainProductId,
      userWallet: receipt.wallet,
      originalTransactionId: receipt.paymentId,
      expiresAt,
      autoRenew: false,
      storeTimestamp: new Date(receipt.timestamp),
      receivedTimestamp: now,
      deduplicationKey,
      raw: receipt.raw ?? receipt,
    };

    const instruction: MintInstruction = {
      productId: onChainProductId,
      user: receipt.wallet,
      expiresAt,
      source: 'x402',
      sourceId: receipt.paymentId,
    };

    this.logger.info('x402 payment processed', {
      paymentId: receipt.paymentId,
      wallet: receipt.wallet,
      productId: onChainProductId,
    });

    return { notification, instruction };
  }

  /**
   * Build a 402 Payment Required response payload.
   *
   * Returns the JSON body that should be sent with an HTTP 402 response
   * to instruct clients how to pay via x402.
   */
  createPaymentRequired(options: {
    productId: string;
    priceUsd: number;
    durationSeconds: number;
    description?: string;
  }): Record<string, unknown> {
    return {
      accepts: ['x402'],
      facilitatorUrl: this.config.facilitatorUrl,
      productId: options.productId,
      price: {
        amount: options.priceUsd,
        currency: 'USD',
      },
      durationSeconds: options.durationSeconds,
      description: options.description ?? '',
    };
  }
}

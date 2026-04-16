import type { MintInstruction, RevokeInstruction, StoreNotification } from '@drakkar.software/doubloon-core';
import { DoubloonError, nullLogger } from '@drakkar.software/doubloon-core';
import Stripe from 'stripe';
import { mapStripeEventType, computeStripeDeduplicationKey } from './notification-map.js';
import type { BridgeResult, StripeBridgeConfig } from './types.js';

/**
 * Minimal Stripe webhook event shape.
 */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: {
    object: Record<string, unknown>;
    previous_attributes?: Record<string, unknown>;
  };
}

/**
 * Stripe webhook bridge.
 *
 * Receives verified Stripe webhook events, maps them to normalized
 * Doubloon notifications, and produces mint/revoke instructions.
 */
export class StripeBridge {
  private readonly config: StripeBridgeConfig;
  private readonly logger: import('@drakkar.software/doubloon-core').Logger;

  constructor(config: StripeBridgeConfig) {
    this.config = config;
    this.logger = config.logger ?? nullLogger;
  }

  /**
   * Handle a Stripe webhook request.
   * Verifies the signature using the webhookSecret and then processes the event.
   */
  async handleNotification(
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<BridgeResult> {
    const bodyStr = typeof body === 'string' ? body : body.toString('utf-8');
    const signature = headers['stripe-signature'];

    if (!signature) {
      throw new DoubloonError('INVALID_SIGNATURE', 'Missing stripe-signature header');
    }

    let event: StripeWebhookEvent;
    try {
      const verified = Stripe.webhooks.constructEvent(
        bodyStr,
        signature,
        this.config.webhookSecret,
      ) as unknown as StripeWebhookEvent;
      event = verified;
    } catch (err) {
      throw new DoubloonError(
        'INVALID_SIGNATURE',
        `Stripe webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (typeof event.type !== 'string' || typeof event.id !== 'string') {
      throw new DoubloonError('INVALID_RECEIPT', 'Malformed Stripe event');
    }

    return this.processEvent(event);
  }

  private async processEvent(event: StripeWebhookEvent): Promise<BridgeResult> {
    const notificationType = mapStripeEventType(
      event.type,
      event.data.previous_attributes,
    );

    const deduplicationKey = computeStripeDeduplicationKey(event.id, event.type);

    const obj = event.data.object;

    // Extract subscription-level data
    const subscriptionId = (obj.id as string) ?? (obj.subscription as string) ?? '';
    const customerId = (obj.customer as string) ?? '';
    const priceId = this.extractPriceId(obj);
    const walletAddress = this.extractWallet(obj);

    // Resolve on-chain product ID from Stripe price ID
    let productId = '';
    if (priceId) {
      const resolved = await this.config.productResolver.resolveProductId('stripe', priceId);
      if (resolved) {
        productId = resolved;
      } else {
        throw new DoubloonError(
          'PRODUCT_NOT_MAPPED',
          `Stripe priceId "${priceId}" has no on-chain mapping`,
        );
      }
    }

    // Resolve wallet: first try metadata.wallet, then fall back to walletResolver
    let userWallet = walletAddress ?? '';
    if (!userWallet && customerId) {
      const resolved = await this.config.walletResolver.resolveWallet('stripe', customerId);
      if (resolved) {
        userWallet = resolved;
      }
    }

    if (!userWallet) {
      throw new DoubloonError(
        'WALLET_NOT_LINKED',
        `No wallet found for Stripe event ${event.id}. ` +
        `Set metadata.wallet on the subscription/customer or link via WalletResolver.`,
      );
    }

    // Validate wallet address format
    if (!this.isValidWalletAddress(userWallet)) {
      throw new DoubloonError('WALLET_NOT_LINKED', `Invalid wallet address format: ${userWallet}`);
    }

    const currentPeriodEnd = obj.current_period_end as number | undefined;
    const cancelAtPeriodEnd = obj.cancel_at_period_end as boolean | undefined;

    const notification: StoreNotification = {
      id: event.id,
      type: notificationType,
      store: 'stripe',
      environment: event.livemode ? 'production' : 'sandbox',
      productId,
      userWallet,
      originalTransactionId: subscriptionId,
      expiresAt: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
      autoRenew: cancelAtPeriodEnd === undefined ? true : !cancelAtPeriodEnd,
      storeTimestamp: new Date(event.created * 1000),
      receivedTimestamp: new Date(),
      deduplicationKey,
      raw: event,
    };

    this.logger.info('Stripe event processed', {
      type: notificationType,
      eventType: event.type,
      eventId: event.id,
    });

    const instruction = this.buildInstruction(notification);

    return { notification, instruction };
  }

  private extractPriceId(obj: Record<string, unknown>): string | null {
    // Subscription object: items.data[0].price.id
    const items = obj.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
    if (items?.data?.[0]?.price?.id) {
      return items.data[0].price.id;
    }

    // Invoice object: lines.data[0].price.id
    const lines = obj.lines as { data?: Array<{ price?: { id?: string } }> } | undefined;
    if (lines?.data?.[0]?.price?.id) {
      return lines.data[0].price.id;
    }

    return null;
  }

  private extractWallet(obj: Record<string, unknown>): string | null {
    // Check metadata.wallet on the subscription/customer object
    const metadata = obj.metadata as Record<string, string> | undefined;
    if (metadata?.wallet) {
      return metadata.wallet;
    }
    return null;
  }

  private buildInstruction(
    notification: StoreNotification,
  ): MintInstruction | RevokeInstruction | null {
    if (!notification.productId) return null;

    switch (notification.type) {
      case 'initial_purchase':
      case 'renewal':
      case 'billing_recovery':
      case 'uncancellation':
        return {
          productId: notification.productId,
          user: notification.userWallet,
          expiresAt: notification.expiresAt,
          source: 'stripe',
          sourceId: notification.originalTransactionId,
        } satisfies MintInstruction;

      case 'expiration':
      case 'revocation':
      case 'refund':
        return {
          productId: notification.productId,
          user: notification.userWallet,
          reason: `stripe:${notification.type}`,
        } satisfies RevokeInstruction;

      case 'cancellation':
      case 'billing_retry_start':
      case 'plan_change':
      case 'test':
        return null;

      default:
        return null;
    }
  }

  private isValidWalletAddress(address: string): boolean {
    // Check if it's a valid Solana address (base58, 32-44 chars) or Ethereum address (42 chars starting with 0x)
    if (!address || typeof address !== 'string') return false;
    // Solana address: base58, typically 32-44 characters
    if (/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,44}$/.test(address)) {
      return true;
    }
    // Ethereum/EVM address: 0x followed by 40 hex characters
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return true;
    }
    return false;
  }
}

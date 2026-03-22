import type { MintInstruction, RevokeInstruction, StoreNotification } from '@doubloon/core';
import { nullLogger } from '@doubloon/core';
import { mapStripeEventType, computeStripeDeduplicationKey } from './notification-map.js';
import type { BridgeResult, StripeBridgeConfig } from './types.js';

/**
 * Minimal Stripe webhook event shape.
 * We keep our own interface to avoid a hard runtime dependency on the Stripe SDK.
 */
interface StripeWebhookEvent {
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
  private readonly logger: import('@doubloon/core').Logger;

  constructor(config: StripeBridgeConfig) {
    this.config = config;
    this.logger = config.logger ?? nullLogger;
  }

  /**
   * Handle a verified Stripe webhook event.
   * The caller is responsible for signature verification using the Stripe SDK
   * and the configured `webhookSecret`.
   */
  async handleNotification(event: StripeWebhookEvent): Promise<BridgeResult> {
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
        this.logger.warn('Unknown Stripe price ID', { priceId, eventType: event.type });
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
      throw new Error(
        `No wallet found for Stripe event ${event.id}. ` +
        `Set metadata.wallet on the subscription/customer or link via WalletResolver.`,
      );
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
}

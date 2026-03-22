import type { MintInstruction, RevokeInstruction, StoreNotification } from '@doubloon/core';
import { nullLogger } from '@doubloon/core';
import { mapGoogleNotificationType, computeGoogleDeduplicationKey } from './notification-map.js';
import type { BridgeResult, GoogleBridgeConfig } from './types.js';

/**
 * Parsed Google Real-Time Developer Notification (RTDN) from Pub/Sub.
 */
interface GoogleRTDN {
  version: string;
  packageName: string;
  eventTimeMillis: string;
  subscriptionNotification?: {
    version: string;
    notificationType: number;
    purchaseToken: string;
    subscriptionId: string;
  };
  testNotification?: {
    version: string;
  };
}

/**
 * Google Play Billing bridge.
 *
 * Receives RTDN messages delivered via Google Cloud Pub/Sub,
 * maps them to normalized Doubloon notifications, and produces
 * mint/revoke instructions for the on-chain entitlement system.
 */
export class GoogleBridge {
  private readonly config: GoogleBridgeConfig;
  private readonly logger: import('@doubloon/core').Logger;

  constructor(config: GoogleBridgeConfig) {
    this.config = config;
    this.logger = config.logger ?? nullLogger;
  }

  /**
   * Handle an incoming Pub/Sub push message body.
   * The `messageData` should be the base64-decoded JSON string from the
   * Pub/Sub message `data` field.
   */
  async handleNotification(messageData: string): Promise<BridgeResult> {
    const rtdn: GoogleRTDN = JSON.parse(messageData);

    if (rtdn.testNotification) {
      const notification: StoreNotification = {
        id: `test-${Date.now()}`,
        type: 'test',
        store: 'google',
        environment: 'production',
        productId: '',
        userWallet: '',
        originalTransactionId: '',
        expiresAt: null,
        autoRenew: false,
        storeTimestamp: new Date(Number(rtdn.eventTimeMillis)),
        receivedTimestamp: new Date(),
        deduplicationKey: `google:test:${rtdn.eventTimeMillis}`,
        raw: rtdn,
      };

      return { notification, instruction: null, requiresAcknowledgment: false };
    }

    const sub = rtdn.subscriptionNotification;
    if (!sub) {
      throw new Error('RTDN contains neither subscription nor test notification');
    }

    const notificationType = mapGoogleNotificationType(sub.notificationType);
    const deduplicationKey = computeGoogleDeduplicationKey(
      notificationType,
      sub.purchaseToken,
      sub.notificationType,
    );

    // Resolve on-chain product ID from Google subscription ID
    const productId = await this.config.productResolver.resolveProductId(
      'google',
      sub.subscriptionId,
    );
    if (!productId) {
      throw new Error(`Unknown Google subscription ID: ${sub.subscriptionId}`);
    }

    // Resolve wallet from purchase token (store user identifier)
    const userWallet = await this.config.walletResolver.resolveWallet(
      'google',
      sub.purchaseToken,
    );
    if (!userWallet) {
      throw new Error(`No wallet linked for Google purchase token: ${sub.purchaseToken}`);
    }

    const storeTimestamp = new Date(Number(rtdn.eventTimeMillis));

    const notification: StoreNotification = {
      id: `${sub.purchaseToken}:${sub.notificationType}`,
      type: notificationType,
      store: 'google',
      environment: 'production',
      productId,
      userWallet,
      originalTransactionId: sub.purchaseToken,
      expiresAt: null, // Would be populated by querying the Purchases API
      autoRenew: ![3, 10, 12, 13].includes(sub.notificationType),
      storeTimestamp,
      receivedTimestamp: new Date(),
      deduplicationKey,
      raw: rtdn,
    };

    this.logger.info('Google RTDN processed', {
      type: notificationType,
      subscriptionId: sub.subscriptionId,
      notificationType: sub.notificationType,
    });

    const instruction = this.buildInstruction(notification);
    const requiresAcknowledgment = notificationType === 'initial_purchase';

    return {
      notification,
      instruction,
      requiresAcknowledgment,
      ...(requiresAcknowledgment
        ? { acknowledgmentDeadline: new Date(storeTimestamp.getTime() + 3 * 24 * 60 * 60 * 1000) }
        : {}),
    };
  }

  private buildInstruction(
    notification: StoreNotification,
  ): MintInstruction | RevokeInstruction | null {
    switch (notification.type) {
      case 'initial_purchase':
      case 'renewal':
      case 'billing_recovery':
      case 'resume':
        return {
          productId: notification.productId,
          user: notification.userWallet,
          expiresAt: notification.expiresAt,
          source: 'google',
          sourceId: notification.originalTransactionId,
        } satisfies MintInstruction;

      case 'revocation':
      case 'expiration':
        return {
          productId: notification.productId,
          user: notification.userWallet,
          reason: `google:${notification.type}`,
        } satisfies RevokeInstruction;

      case 'cancellation':
      case 'grace_period_start':
      case 'billing_retry_start':
      case 'price_increase_consent':
      case 'pause':
      case 'test':
        return null;

      default:
        return null;
    }
  }
}

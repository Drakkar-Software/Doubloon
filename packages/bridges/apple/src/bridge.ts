import type { StoreNotification, MintInstruction, RevokeInstruction, NotificationType, Logger } from '@doubloon/core';
import { DoubloonError, nullLogger } from '@doubloon/core';
import type { StoreProductResolver } from '@doubloon/storage';
import type { WalletResolver } from '@doubloon/auth';
import { mapAppleNotificationType, computeAppleDeduplicationKey } from './notification-map.js';
import type { BridgeResult, BridgeReconcileResult, AppleBridgeConfig } from './types.js';

export class AppleBridge {
  private productResolver: StoreProductResolver;
  private walletResolver: WalletResolver;
  private environment: 'production' | 'sandbox';
  private bundleId: string;
  private issuerId: string;
  private keyId: string;
  private privateKey: string;
  private logger: Logger;

  constructor(config: AppleBridgeConfig) {
    this.environment = config.environment;
    this.bundleId = config.bundleId;
    this.issuerId = config.issuerId;
    this.keyId = config.keyId;
    this.privateKey = config.privateKey;
    this.productResolver = config.productResolver;
    this.walletResolver = config.walletResolver;
    this.logger = config.logger ?? nullLogger;
  }

  async handleNotification(
    _headers: Record<string, string>,
    _body: Buffer,
  ): Promise<BridgeResult> {
    // TODO: Implement JWS signature verification (see Apple Server Notifications V2 docs)
    const bodyStr = _body.toString('utf-8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(bodyStr);
    } catch {
      throw new DoubloonError('INVALID_RECEIPT', 'Invalid Apple notification body');
    }

    const notificationType = parsed.notificationType as string;
    const subtype = parsed.subtype as string | undefined;
    const transactionInfo = parsed.transactionInfo as Record<string, unknown> | undefined;

    if (!notificationType) {
      throw new DoubloonError('INVALID_RECEIPT', 'Missing notificationType');
    }

    const normalizedType = mapAppleNotificationType(notificationType, subtype);

    const appleProductId = transactionInfo?.productId as string | undefined;
    if (!appleProductId) {
      const notification = this.buildEmptyNotification(notificationType, subtype, normalizedType);
      return { notification, instruction: null };
    }

    const onChainProductId = await this.productResolver.resolveProductId('apple', appleProductId);
    if (!onChainProductId) {
      throw new DoubloonError('PRODUCT_NOT_MAPPED', `Apple productId "${appleProductId}" has no on-chain mapping`);
    }

    const wallet = await this.resolveWalletFromTransaction(transactionInfo);

    const notification = this.buildNotification(
      transactionInfo!,
      onChainProductId,
      wallet ?? '',
      normalizedType,
    );

    const instruction = this.mapToInstruction(
      normalizedType,
      onChainProductId,
      wallet,
      transactionInfo!,
    );

    return { notification, instruction };
  }

  async reconcile(
    _originalTransactionId: string,
    _currentOnChainState: import('@doubloon/core').Entitlement | null,
  ): Promise<BridgeReconcileResult> {
    // Placeholder - would query Apple API in production
    return { drift: false, instruction: null };
  }

  private async resolveWalletFromTransaction(
    tx: Record<string, unknown> | undefined,
  ): Promise<string | null> {
    if (!tx) return null;
    if (tx.appAccountToken) {
      const wallet = await this.walletResolver.resolveWallet('apple', String(tx.appAccountToken));
      if (wallet) return wallet;
    }
    return this.walletResolver.resolveWallet(
      'apple',
      String(tx.originalTransactionId ?? tx.transactionId),
    );
  }

  private mapToInstruction(
    type: NotificationType,
    productId: string,
    wallet: string | null,
    tx: Record<string, unknown>,
  ): MintInstruction | RevokeInstruction | null {
    if (!wallet) return null;

    switch (type) {
      case 'initial_purchase':
      case 'renewal':
      case 'billing_recovery':
      case 'offer_redeemed':
      case 'plan_change':
        return {
          productId,
          user: wallet,
          expiresAt: tx.expiresDate ? new Date(tx.expiresDate as number) : null,
          source: 'apple',
          sourceId: String(tx.originalTransactionId ?? tx.transactionId ?? ''),
        };

      case 'expiration':
      case 'refund':
      case 'revocation':
        return {
          productId,
          user: wallet,
          reason: `apple:${type}`,
        };

      case 'cancellation':
      case 'uncancellation':
      case 'grace_period_start':
      case 'billing_retry_start':
      case 'price_increase_consent':
      case 'pause':
      case 'resume':
      case 'test':
        return null;

      default:
        this.logger.warn('Unknown notification type', { type });
        return null;
    }
  }

  private buildNotification(
    tx: Record<string, unknown>,
    productId: string,
    wallet: string,
    type: NotificationType,
  ): StoreNotification {
    return {
      id: String(tx.transactionId ?? ''),
      type,
      store: 'apple',
      environment: this.environment,
      productId,
      userWallet: wallet,
      originalTransactionId: String(tx.originalTransactionId ?? tx.transactionId ?? ''),
      expiresAt: tx.expiresDate ? new Date(tx.expiresDate as number) : null,
      autoRenew: type !== 'cancellation' && type !== 'expiration' && (tx.autoRenewStatus as number) !== 0,
      storeTimestamp: tx.purchaseDate ? new Date(tx.purchaseDate as number) : new Date(),
      receivedTimestamp: new Date(),
      deduplicationKey: computeAppleDeduplicationKey(type, tx as any),
      raw: tx,
    };
  }

  private buildEmptyNotification(
    appleType: string,
    subtype: string | undefined,
    normalizedType: NotificationType,
  ): StoreNotification {
    return {
      id: '',
      type: normalizedType,
      store: 'apple',
      environment: this.environment,
      productId: '',
      userWallet: '',
      originalTransactionId: '',
      expiresAt: null,
      autoRenew: false,
      storeTimestamp: new Date(),
      receivedTimestamp: new Date(),
      deduplicationKey: `apple:${appleType}:${subtype ?? ''}:empty`,
      raw: { notificationType: appleType, subtype },
    };
  }
}

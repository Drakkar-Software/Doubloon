import type { NotificationType } from '@doubloon/core';

export function mapAppleNotificationType(
  appleType: string,
  appleSubtype?: string,
): NotificationType {
  switch (appleType) {
    case 'SUBSCRIBED':
      return appleSubtype === 'RESUBSCRIBE' ? 'renewal' : 'initial_purchase';
    case 'DID_RENEW':
      return 'renewal';
    case 'DID_CHANGE_RENEWAL_STATUS':
      return appleSubtype === 'AUTO_RENEW_DISABLED' ? 'cancellation' : 'uncancellation';
    case 'DID_CHANGE_RENEWAL_INFO':
      if (appleSubtype === 'DOWNGRADE' || appleSubtype === 'UPGRADE') return 'plan_change';
      if (appleSubtype === 'AUTO_RENEW_DISABLED') return 'cancellation';
      if (appleSubtype === 'AUTO_RENEW_ENABLED') return 'uncancellation';
      return 'plan_change';
    case 'EXPIRED':
      return 'expiration';
    case 'DID_FAIL_TO_RENEW':
      return appleSubtype === 'GRACE_PERIOD' ? 'grace_period_start' : 'billing_retry_start';
    case 'GRACE_PERIOD_EXPIRED':
      return 'expiration';
    case 'REFUND':
      return 'refund';
    case 'REFUND_DECLINED':
    case 'REFUND_REVERSED':
      return 'billing_recovery';
    case 'REVOKE':
      return 'revocation';
    case 'RENEWAL_EXTENDED':
      return 'renewal';
    case 'PRICE_INCREASE':
      return 'price_increase_consent';
    case 'OFFER_REDEEMED':
      return 'offer_redeemed';
    case 'TEST':
      return 'test';
    default:
      return 'test';
  }
}

export function computeAppleDeduplicationKey(
  type: NotificationType,
  tx: { transactionId?: string | number; signedDate?: number; originalTransactionId?: string | number },
): string {
  return `apple:${type}:${tx.originalTransactionId ?? ''}:${tx.transactionId ?? ''}:${tx.signedDate ?? ''}`;
}

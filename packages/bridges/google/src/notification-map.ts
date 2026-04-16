import type { NotificationType } from '@drakkar.software/doubloon-core';

export function mapGoogleNotificationType(rtdnType: number): NotificationType {
  switch (rtdnType) {
    case 1: return 'billing_recovery';       // RECOVERED
    case 2: return 'renewal';                // RENEWED
    case 3: return 'cancellation';           // CANCELED
    case 4: return 'initial_purchase';       // PURCHASED
    case 5: return 'billing_retry_start';    // ON_HOLD
    case 6: return 'grace_period_start';     // IN_GRACE_PERIOD
    case 7: return 'renewal';                // RESTARTED
    case 8: return 'price_increase_consent'; // PRICE_CHANGE_CONFIRMED
    case 9: return 'renewal';                // DEFERRED
    case 10: return 'pause';                 // PAUSED
    case 11: return 'resume';                // PAUSE_SCHEDULE_CHANGED
    case 12: return 'revocation';            // REVOKED
    case 13: return 'expiration';            // EXPIRED
    default: throw new Error(
      `Unknown Google RTDN notification type: ${rtdnType}. ` +
      `Update mapGoogleNotificationType to handle this type.`,
    );
  }
}

export function computeGoogleDeduplicationKey(
  type: NotificationType,
  purchaseToken: string,
  notificationType: number,
): string {
  return `google:${type}:${purchaseToken}:${notificationType}`;
}

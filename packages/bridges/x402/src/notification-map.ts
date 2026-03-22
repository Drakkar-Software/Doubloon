import type { NotificationType } from '@doubloon/core';

/**
 * x402 payments always represent an initial purchase — there is no
 * subscription lifecycle, so the notification type is always 'initial_purchase'.
 */
export function mapX402PaymentType(): NotificationType {
  return 'initial_purchase';
}

export function computeX402DeduplicationKey(
  paymentId: string,
  wallet: string,
): string {
  return `x402:initial_purchase:${wallet}:${paymentId}`;
}

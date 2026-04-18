import type { NotificationType } from '@drakkar.software/doubloon-core';

export function mapStripeEventType(
  eventType: string,
  previousAttributes?: Record<string, unknown>,
): NotificationType {
  switch (eventType) {
    case 'customer.subscription.created':
      return 'initial_purchase';
    case 'customer.subscription.updated':
      if (previousAttributes) {
        if ('cancel_at_period_end' in previousAttributes) {
          return previousAttributes.cancel_at_period_end ? 'uncancellation' : 'cancellation';
        }
        if ('items' in previousAttributes) return 'plan_change';
        if ('status' in previousAttributes) return 'renewal';
      }
      return 'renewal';
    case 'customer.subscription.deleted':
      return 'expiration';
    case 'invoice.payment_succeeded':
      return 'renewal';
    case 'invoice.payment_failed':
      return 'billing_retry_start';
    case 'charge.refunded':
      return 'refund';
    case 'checkout.session.completed':
      return 'initial_purchase';
    default:
      throw new Error(
        `Unknown Stripe event type: "${eventType}". ` +
        `Update mapStripeEventType to handle this type.`,
      );
  }
}

export function computeStripeDeduplicationKey(
  eventId: string,
  eventType: string,
): string {
  return `stripe:${eventType}:${eventId}`;
}

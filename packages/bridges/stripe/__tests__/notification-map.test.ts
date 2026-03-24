import { describe, it, expect } from 'vitest';
import { mapStripeEventType, computeStripeDeduplicationKey } from '../src/notification-map.js';

describe('mapStripeEventType', () => {
  it('maps customer.subscription.created to initial_purchase', () => {
    expect(mapStripeEventType('customer.subscription.created')).toBe('initial_purchase');
  });

  it('maps customer.subscription.deleted to expiration', () => {
    expect(mapStripeEventType('customer.subscription.deleted')).toBe('expiration');
  });

  it('maps invoice.payment_succeeded to renewal', () => {
    expect(mapStripeEventType('invoice.payment_succeeded')).toBe('renewal');
  });

  it('maps invoice.payment_failed to billing_retry_start', () => {
    expect(mapStripeEventType('invoice.payment_failed')).toBe('billing_retry_start');
  });

  it('maps charge.refunded to refund', () => {
    expect(mapStripeEventType('charge.refunded')).toBe('refund');
  });

  it('maps unknown event types to test', () => {
    expect(() => mapStripeEventType('some.unknown.event')).toThrow();
  });

  describe('customer.subscription.updated sub-cases', () => {
    it('maps to cancellation when cancel_at_period_end was false (now true)', () => {
      expect(
        mapStripeEventType('customer.subscription.updated', {
          cancel_at_period_end: false,
        }),
      ).toBe('cancellation');
    });

    it('maps to uncancellation when cancel_at_period_end was true (now false)', () => {
      expect(
        mapStripeEventType('customer.subscription.updated', {
          cancel_at_period_end: true,
        }),
      ).toBe('uncancellation');
    });

    it('maps to plan_change when items changed', () => {
      expect(
        mapStripeEventType('customer.subscription.updated', {
          items: { data: [] },
        }),
      ).toBe('plan_change');
    });

    it('maps to renewal when status changed', () => {
      expect(
        mapStripeEventType('customer.subscription.updated', {
          status: 'past_due',
        }),
      ).toBe('renewal');
    });

    it('maps to renewal with no previous_attributes', () => {
      expect(mapStripeEventType('customer.subscription.updated')).toBe('renewal');
    });

    it('maps to renewal with empty previous_attributes', () => {
      expect(mapStripeEventType('customer.subscription.updated', {})).toBe('renewal');
    });
  });
});

describe('computeStripeDeduplicationKey', () => {
  it('produces deterministic keys', () => {
    const key = computeStripeDeduplicationKey('evt_123', 'customer.subscription.created');
    expect(key).toBe('stripe:customer.subscription.created:evt_123');
  });

  it('produces different keys for different events', () => {
    const key1 = computeStripeDeduplicationKey('evt_123', 'customer.subscription.created');
    const key2 = computeStripeDeduplicationKey('evt_456', 'customer.subscription.deleted');
    expect(key1).not.toBe(key2);
  });
});

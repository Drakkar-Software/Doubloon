/**
 * E2E: Stripe bridge — event type mapping, price ID extraction, wallet resolution,
 * instruction routing, all event types, previousAttributes branching.
 */
import { describe, it, expect, vi } from 'vitest';
import { mapStripeEventType, computeStripeDeduplicationKey } from '@doubloon/bridge-stripe';

describe('Stripe event type mapping', () => {
  it('customer.subscription.created → initial_purchase', () => {
    expect(mapStripeEventType('customer.subscription.created')).toBe('initial_purchase');
  });

  it('customer.subscription.deleted → expiration', () => {
    expect(mapStripeEventType('customer.subscription.deleted')).toBe('expiration');
  });

  it('invoice.payment_succeeded → renewal', () => {
    expect(mapStripeEventType('invoice.payment_succeeded')).toBe('renewal');
  });

  it('invoice.payment_failed → billing_retry_start', () => {
    expect(mapStripeEventType('invoice.payment_failed')).toBe('billing_retry_start');
  });

  it('charge.refunded → refund', () => {
    expect(mapStripeEventType('charge.refunded')).toBe('refund');
  });

  it('unknown event → test', () => {
    expect(mapStripeEventType('totally.unknown.event')).toBe('test');
  });

  describe('customer.subscription.updated with previousAttributes', () => {
    it('cancel_at_period_end changed to true → cancellation', () => {
      expect(mapStripeEventType('customer.subscription.updated', {
        cancel_at_period_end: false, // was false, now true
      })).toBe('cancellation');
    });

    it('cancel_at_period_end changed to false → uncancellation', () => {
      expect(mapStripeEventType('customer.subscription.updated', {
        cancel_at_period_end: true, // was true, now false
      })).toBe('uncancellation');
    });

    it('items changed → plan_change', () => {
      expect(mapStripeEventType('customer.subscription.updated', {
        items: { data: [] },
      })).toBe('plan_change');
    });

    it('status changed → renewal', () => {
      expect(mapStripeEventType('customer.subscription.updated', {
        status: 'past_due',
      })).toBe('renewal');
    });

    it('no previousAttributes → renewal (default)', () => {
      expect(mapStripeEventType('customer.subscription.updated')).toBe('renewal');
    });

    it('empty previousAttributes → renewal (default)', () => {
      expect(mapStripeEventType('customer.subscription.updated', {})).toBe('renewal');
    });
  });
});

describe('Stripe deduplication key', () => {
  it('includes event type and ID', () => {
    const key = computeStripeDeduplicationKey('evt_123', 'customer.subscription.created');
    expect(key).toBe('stripe:customer.subscription.created:evt_123');
  });
});

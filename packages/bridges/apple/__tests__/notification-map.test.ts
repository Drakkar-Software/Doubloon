import { describe, it, expect } from 'vitest';
import { mapAppleNotificationType, computeAppleDeduplicationKey } from '../src/notification-map.js';

describe('mapAppleNotificationType', () => {
  it('SUBSCRIBED → initial_purchase', () => {
    expect(mapAppleNotificationType('SUBSCRIBED')).toBe('initial_purchase');
  });
  it('SUBSCRIBED + RESUBSCRIBE → renewal', () => {
    expect(mapAppleNotificationType('SUBSCRIBED', 'RESUBSCRIBE')).toBe('renewal');
  });
  it('DID_RENEW → renewal', () => {
    expect(mapAppleNotificationType('DID_RENEW')).toBe('renewal');
  });
  it('DID_CHANGE_RENEWAL_STATUS + AUTO_RENEW_DISABLED → cancellation', () => {
    expect(mapAppleNotificationType('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED')).toBe('cancellation');
  });
  it('DID_CHANGE_RENEWAL_STATUS + AUTO_RENEW_ENABLED → uncancellation', () => {
    expect(mapAppleNotificationType('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_ENABLED')).toBe('uncancellation');
  });
  it('EXPIRED → expiration', () => {
    expect(mapAppleNotificationType('EXPIRED')).toBe('expiration');
  });
  it('DID_FAIL_TO_RENEW + GRACE_PERIOD → grace_period_start', () => {
    expect(mapAppleNotificationType('DID_FAIL_TO_RENEW', 'GRACE_PERIOD')).toBe('grace_period_start');
  });
  it('DID_FAIL_TO_RENEW (no subtype) → billing_retry_start', () => {
    expect(mapAppleNotificationType('DID_FAIL_TO_RENEW')).toBe('billing_retry_start');
  });
  it('REFUND → refund', () => {
    expect(mapAppleNotificationType('REFUND')).toBe('refund');
  });
  it('REVOKE → revocation', () => {
    expect(mapAppleNotificationType('REVOKE')).toBe('revocation');
  });
  it('OFFER_REDEEMED → offer_redeemed', () => {
    expect(mapAppleNotificationType('OFFER_REDEEMED')).toBe('offer_redeemed');
  });
  it('TEST → test', () => {
    expect(mapAppleNotificationType('TEST')).toBe('test');
  });
  it('unknown → test', () => {
    expect(mapAppleNotificationType('UNKNOWN_TYPE')).toBe('test');
  });
  it('DID_CHANGE_RENEWAL_INFO + UPGRADE → plan_change', () => {
    expect(mapAppleNotificationType('DID_CHANGE_RENEWAL_INFO', 'UPGRADE')).toBe('plan_change');
  });
  it('REFUND_REVERSED → billing_recovery', () => {
    expect(mapAppleNotificationType('REFUND_REVERSED')).toBe('billing_recovery');
  });
  it('PRICE_INCREASE → price_increase_consent', () => {
    expect(mapAppleNotificationType('PRICE_INCREASE')).toBe('price_increase_consent');
  });
  it('RENEWAL_EXTENDED → renewal', () => {
    expect(mapAppleNotificationType('RENEWAL_EXTENDED')).toBe('renewal');
  });
  it('GRACE_PERIOD_EXPIRED → expiration', () => {
    expect(mapAppleNotificationType('GRACE_PERIOD_EXPIRED')).toBe('expiration');
  });
});

describe('computeAppleDeduplicationKey', () => {
  it('produces deterministic key', () => {
    const tx = { transactionId: '123', originalTransactionId: '100', signedDate: 1000 };
    const a = computeAppleDeduplicationKey('renewal', tx);
    const b = computeAppleDeduplicationKey('renewal', tx);
    expect(a).toBe(b);
  });

  it('different notifications produce different keys', () => {
    const tx1 = { transactionId: '123', originalTransactionId: '100', signedDate: 1000 };
    const tx2 = { transactionId: '456', originalTransactionId: '100', signedDate: 2000 };
    expect(computeAppleDeduplicationKey('renewal', tx1)).not.toBe(computeAppleDeduplicationKey('renewal', tx2));
  });
});

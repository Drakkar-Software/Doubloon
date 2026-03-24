import { describe, it, expect } from 'vitest';
import { mapGoogleNotificationType, computeGoogleDeduplicationKey } from '../src/notification-map.js';

describe('mapGoogleNotificationType', () => {
  const cases: Array<[number, string, string]> = [
    [1, 'billing_recovery', 'RECOVERED'],
    [2, 'renewal', 'RENEWED'],
    [3, 'cancellation', 'CANCELED'],
    [4, 'initial_purchase', 'PURCHASED'],
    [5, 'billing_retry_start', 'ON_HOLD'],
    [6, 'grace_period_start', 'IN_GRACE_PERIOD'],
    [7, 'renewal', 'RESTARTED'],
    [8, 'price_increase_consent', 'PRICE_CHANGE_CONFIRMED'],
    [9, 'renewal', 'DEFERRED'],
    [10, 'pause', 'PAUSED'],
    [11, 'resume', 'PAUSE_SCHEDULE_CHANGED'],
    [12, 'revocation', 'REVOKED'],
    [13, 'expiration', 'EXPIRED'],
  ];

  it.each(cases)(
    'maps RTDN type %d (%s) to %s',
    (rtdnType, expectedNotificationType) => {
      expect(mapGoogleNotificationType(rtdnType)).toBe(expectedNotificationType);
    },
  );

  it('maps unknown types to test', () => {
    expect(() => mapGoogleNotificationType(0)).toThrow();
    expect(() => mapGoogleNotificationType(99)).toThrow();
    expect(() => mapGoogleNotificationType(-1)).toThrow();
  });
});

describe('computeGoogleDeduplicationKey', () => {
  it('produces deterministic keys', () => {
    const key = computeGoogleDeduplicationKey('renewal', 'token-abc', 2);
    expect(key).toBe('google:renewal:token-abc:2');
  });

  it('produces different keys for different inputs', () => {
    const key1 = computeGoogleDeduplicationKey('renewal', 'token-abc', 2);
    const key2 = computeGoogleDeduplicationKey('initial_purchase', 'token-abc', 4);
    expect(key1).not.toBe(key2);
  });
});

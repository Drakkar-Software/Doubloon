import type { EntitlementCheck } from '@doubloon/core';

export interface UseEntitlementConfig {
  productId: string;
  wallet: string | null;
  reader: {
    checkEntitlement(productId: string, wallet: string): Promise<EntitlementCheck>;
  };
  pollIntervalMs?: number;
}

export interface UseEntitlementResult {
  loading: boolean;
  entitled: boolean;
  check: EntitlementCheck | null;
  error: Error | null;
  refresh: () => Promise<void>;
}

export interface UsePurchaseConfig {
  serverUrl: string;
  wallet: string | null;
}

export interface UsePurchaseResult {
  purchasing: boolean;
  error: Error | null;
  purchase: (productId: string, receipt: unknown) => Promise<boolean>;
}

// These are React hook signatures - actual implementation requires React
// They're exported as type references for the package API

export function createEntitlementChecker(config: {
  reader: UseEntitlementConfig['reader'];
}) {
  return {
    async check(productId: string, wallet: string): Promise<EntitlementCheck> {
      return config.reader.checkEntitlement(productId, wallet);
    },
    async checkBatch(productIds: string[], wallet: string): Promise<Record<string, EntitlementCheck>> {
      const checks = await Promise.all(
        productIds.map((pid) => config.reader.checkEntitlement(pid, wallet)),
      );
      const results: Record<string, EntitlementCheck> = {};
      for (let i = 0; i < productIds.length; i++) {
        results[productIds[i]] = checks[i];
      }
      return results;
    },
  };
}

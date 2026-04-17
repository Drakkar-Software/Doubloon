import type { StoreNotification, MintInstruction, RevokeInstruction } from '@drakkar.software/doubloon-core';

export interface BridgeResult {
  notification: StoreNotification;
  instruction: MintInstruction | RevokeInstruction | null;
}

export interface BridgeReconcileResult {
  drift: boolean;
  instruction: MintInstruction | RevokeInstruction | null;
}

export interface AppleBridgeConfig {
  bundleId: string;
  issuerId: string;
  keyId: string;
  privateKey: string;
  /** @deprecated Environment is derived from the signed JWS payload. This field is ignored. */
  environment?: 'production' | 'sandbox';
  rootCertificates?: Buffer[];
  appAppleId?: number;
  productResolver: { resolveProductId(store: string, storeSku: string): Promise<string | null> };
  walletResolver: import('@drakkar.software/doubloon-core').WalletResolver;
  logger?: import('@drakkar.software/doubloon-core').Logger;
}

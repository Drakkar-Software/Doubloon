import type { StoreNotification, MintInstruction, RevokeInstruction } from '@doubloon/core';

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
  environment: 'production' | 'sandbox';
  rootCertificates?: Buffer[];
  appAppleId?: number;
  productResolver: import('@doubloon/storage').StoreProductResolver;
  walletResolver: import('@doubloon/auth').WalletResolver;
  logger?: import('@doubloon/core').Logger;
}

import type { StoreNotification, MintInstruction, RevokeInstruction } from '@doubloon/core';

export interface BridgeResult {
  notification: StoreNotification;
  instruction: MintInstruction | RevokeInstruction | null;
  requiresAcknowledgment: boolean;
  acknowledgmentDeadline?: Date;
}

export interface GoogleBridgeConfig {
  packageName: string;
  serviceAccountKey: string;
  /** Environment override. Defaults to 'production'. Test notifications always use 'sandbox'. */
  environment?: 'production' | 'sandbox';
  productResolver: import('@doubloon/storage').StoreProductResolver;
  walletResolver: import('@doubloon/auth').WalletResolver;
  logger?: import('@doubloon/core').Logger;
}

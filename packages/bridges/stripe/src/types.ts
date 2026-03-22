import type { StoreNotification, MintInstruction, RevokeInstruction } from '@doubloon/core';

export interface BridgeResult {
  notification: StoreNotification;
  instruction: MintInstruction | RevokeInstruction | null;
}

export interface StripeBridgeConfig {
  webhookSecret: string;
  productResolver: import('@doubloon/storage').StoreProductResolver;
  walletResolver: import('@doubloon/auth').WalletResolver;
  logger?: import('@doubloon/core').Logger;
}

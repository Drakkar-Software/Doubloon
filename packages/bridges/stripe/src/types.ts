import type { StoreNotification, MintInstruction, RevokeInstruction } from '@doubloon/core';

export interface BridgeResult {
  notification: StoreNotification;
  instruction: MintInstruction | RevokeInstruction | null;
}

export interface StripeBridgeConfig {
  webhookSecret: string;
  productResolver: { resolveProductId(store: string, storeSku: string): Promise<string | null> };
  walletResolver: import('@doubloon/auth').WalletResolver;
  logger?: import('@doubloon/core').Logger;
}

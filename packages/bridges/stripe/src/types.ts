import type { StoreNotification, MintInstruction, RevokeInstruction } from '@drakkar.software/doubloon-core';

export interface BridgeResult {
  notification: StoreNotification;
  instruction: MintInstruction | RevokeInstruction | null;
}

export interface StripeBridgeConfig {
  webhookSecret: string;
  productResolver: { resolveProductId(store: string, storeSku: string): Promise<string | null> };
  walletResolver: import('@drakkar.software/doubloon-core').WalletResolver;
  logger?: import('@drakkar.software/doubloon-core').Logger;
}

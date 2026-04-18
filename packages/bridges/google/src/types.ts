import type { StoreNotification, MintInstruction, RevokeInstruction } from '@drakkar.software/doubloon-core';

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
  productResolver: { resolveProductId(store: string, storeSku: string): Promise<string | null> };
  walletResolver: import('@drakkar.software/doubloon-core').WalletResolver;
  /** Optional custom wallet address validator. Overrides the default Solana/EVM check. */
  walletValidator?: (address: string) => boolean;
  logger?: import('@drakkar.software/doubloon-core').Logger;
}

import type { StoreNotification, MintInstruction } from '@doubloon/core';

export interface X402BridgeResult {
  notification: StoreNotification;
  instruction: MintInstruction;
}

export interface X402BridgeConfig {
  facilitatorUrl: string;
  productResolver: { resolveProductId(store: string, storeSku: string): Promise<string | null> };
  logger?: import('@doubloon/core').Logger;
}

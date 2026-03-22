export interface X402MiddlewareConfig {
  bridge: import('./bridge.js').X402Bridge;
  productId: string;
  priceUsd: number;
  durationSeconds: number;
}

export function createX402Middleware(_config: X402MiddlewareConfig) {
  return async (req: any, res: any, next: any) => {
    // Check entitlement first, then fall back to x402 payment
    // Placeholder - full implementation depends on framework
    next();
  };
}

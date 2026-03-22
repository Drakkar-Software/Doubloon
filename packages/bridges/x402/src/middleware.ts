import type { X402Bridge } from './bridge.js';

export interface X402MiddlewareConfig {
  bridge: X402Bridge;
  productId: string;
  priceUsd: number;
  durationSeconds: number;
}

export function createX402Middleware(config: X402MiddlewareConfig) {
  return async (req: any, res: any, next: any) => {
    // Check if request has a payment header
    const paymentHeader = req.headers?.['x-payment'] || req.headers?.['payment'];

    if (!paymentHeader) {
      // No payment provided — return 402 Payment Required
      const paymentRequired = config.bridge.createPaymentRequired({
        productId: config.productId,
        priceUsd: config.priceUsd,
        durationSeconds: config.durationSeconds,
      });
      res.status?.(402);
      res.json?.(paymentRequired) || res.end?.(JSON.stringify(paymentRequired));
      return;
    }

    try {
      // Verify payment and mint entitlement using the raw payment header
      const result = await config.bridge.verifyAndMint(paymentHeader);
      // Attach entitlement info to request for downstream handlers
      req.doubloon = {
        entitled: true,
        wallet: result.notification.userWallet,
        productId: config.productId,
      };
      next();
    } catch (err) {
      res.status?.(402);
      res.json?.({ error: 'Payment verification failed' }) || res.end?.('Payment verification failed');
    }
  };
}

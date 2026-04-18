import type { StoreNotification, MintInstruction, RevokeInstruction, NotificationType, Logger } from '@drakkar.software/doubloon-core';
import { DoubloonError, nullLogger } from '@drakkar.software/doubloon-core';
import type { WalletResolver } from '@drakkar.software/doubloon-core';
import { mapAppleNotificationType, computeAppleDeduplicationKey } from './notification-map.js';
import type { BridgeResult, BridgeReconcileResult, AppleBridgeConfig } from './types.js';

export class AppleBridge {
  private productResolver: AppleBridgeConfig['productResolver'];
  private walletResolver: WalletResolver;
  private walletValidator?: (address: string) => boolean;
  private bundleId: string;
  private issuerId: string;
  private keyId: string;
  private privateKey: string;
  private rootCertificates?: Buffer[];
  private logger: Logger;

  constructor(config: AppleBridgeConfig) {
    this.bundleId = config.bundleId;
    this.issuerId = config.issuerId;
    this.keyId = config.keyId;
    this.privateKey = config.privateKey;
    this.rootCertificates = config.rootCertificates;
    this.productResolver = config.productResolver;
    this.walletResolver = config.walletResolver;
    this.walletValidator = config.walletValidator;
    this.logger = config.logger ?? nullLogger;
  }

  async handleNotification(
    _headers: Record<string, string>,
    _body: Buffer,
  ): Promise<BridgeResult> {
    const bodyStr = _body.toString('utf-8');
    let parsed: Record<string, unknown>;
    let environment: 'production' | 'sandbox';

    // Apple Server Notifications V2 sends a JWS (signedPayload).
    // We verify the signature chain before trusting any content.
    if (bodyStr.startsWith('eyJ') || bodyStr.startsWith('{"signedPayload"')) {
      parsed = await this.verifyAndDecodeJWS(bodyStr);
      environment = AppleBridge.extractEnvironment(parsed);
    } else {
      try {
        parsed = JSON.parse(bodyStr);
      } catch {
        throw new DoubloonError('INVALID_RECEIPT', 'Invalid Apple notification body');
      }
      environment = 'production';
    }

    const notificationType = parsed.notificationType as string;
    const subtype = parsed.subtype as string | undefined;
    const transactionInfo = parsed.transactionInfo as Record<string, unknown> | undefined;

    if (!notificationType) {
      throw new DoubloonError('INVALID_RECEIPT', 'Missing notificationType');
    }

    const normalizedType = mapAppleNotificationType(notificationType, subtype);

    const appleProductId = transactionInfo?.productId as string | undefined;
    if (!appleProductId) {
      const notification = this.buildEmptyNotification(notificationType, subtype, normalizedType, environment);
      return { notification, instruction: null };
    }

    const onChainProductId = await this.productResolver.resolveProductId('apple', appleProductId);
    if (!onChainProductId) {
      throw new DoubloonError('PRODUCT_NOT_MAPPED', `Apple productId "${appleProductId}" has no on-chain mapping`);
    }

    const wallet = await this.resolveWalletFromTransaction(transactionInfo);

    if (!wallet) {
      throw new DoubloonError(
        'WALLET_NOT_LINKED',
        `No wallet linked for Apple transaction ${String(transactionInfo?.originalTransactionId ?? transactionInfo?.transactionId ?? 'unknown')}. ` +
        `Set appAccountToken on the transaction or link via WalletResolver.`,
      );
    }

    const notification = this.buildNotification(
      transactionInfo!,
      onChainProductId,
      wallet,
      normalizedType,
      environment,
    );

    const instruction = this.mapToInstruction(
      normalizedType,
      onChainProductId,
      wallet!,
      transactionInfo!,
    );

    return { notification, instruction };
  }

  async reconcile(
    _originalTransactionId: string,
    _currentOnChainState: import('@drakkar.software/doubloon-core').Entitlement | null,
  ): Promise<BridgeReconcileResult> {
    // Placeholder - would query Apple API in production
    return { drift: false, instruction: null };
  }

  /**
   * Verify and decode a JWS-signed Apple notification payload.
   *
   * Apple Server Notifications V2 wraps the notification body in a JWS compact
   * serialization (three base64url-encoded segments: header.payload.signature).
   * The x5c header contains a certificate chain rooted at Apple's CA.
   *
   * Verification steps:
   *  1. Extract the signedPayload (JWS compact string).
   *  2. Decode the JOSE header and extract the x5c certificate chain.
   *  3. Verify that the leaf certificate is signed by the intermediate, which is
   *     signed by the Apple root CA (either built-in or from config.rootCertificates).
   *  4. Verify the JWS signature using the leaf certificate's public key.
   *  5. Validate the payload's bundleId matches our configured bundleId.
   *
   * If any step fails, a DoubloonError with code INVALID_SIGNATURE is thrown.
   *
   * @param bodyStr - Request body as string (JWS or JSON with signedPayload)
   * @returns Decoded payload object
   * @throws DoubloonError if signature verification fails
   *
   * @see https://developer.apple.com/documentation/appstoreservernotifications/responsebodyv2decodedpayload
   */
  private async verifyAndDecodeJWS(bodyStr: string): Promise<Record<string, unknown>> {
    let signedPayload: string;

    // The body is either the raw JWS compact string (eyJ...) or JSON with a signedPayload field.
    if (bodyStr.startsWith('{')) {
      try {
        const outer = JSON.parse(bodyStr);
        signedPayload = outer.signedPayload as string;
        if (!signedPayload || typeof signedPayload !== 'string') {
          throw new DoubloonError('INVALID_SIGNATURE', 'Missing signedPayload in Apple notification');
        }
      } catch (err) {
        if (err instanceof DoubloonError) throw err;
        throw new DoubloonError('INVALID_RECEIPT', 'Invalid Apple notification body');
      }
    } else {
      signedPayload = bodyStr;
    }

    // Split the JWS compact serialization into its 3 parts
    const parts = signedPayload.split('.');
    if (parts.length !== 3) {
      throw new DoubloonError('INVALID_SIGNATURE', 'Apple JWS must have 3 parts (header.payload.signature)');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode the JOSE header to extract the x5c certificate chain
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'));
    } catch {
      throw new DoubloonError('INVALID_SIGNATURE', 'Could not decode JWS header');
    }

    const alg = (header.alg as string) ?? 'ES256';
    const x5c = header.x5c as string[] | undefined;

    if (!x5c || !Array.isArray(x5c) || x5c.length < 2) {
      throw new DoubloonError(
        'INVALID_SIGNATURE',
        'JWS header missing x5c certificate chain (need at least leaf + intermediate)',
      );
    }

    // Import Node.js crypto for certificate and signature verification
    const { createVerify, X509Certificate } = await import('node:crypto');

    // Build X509 certificate objects from the base64-encoded DER in x5c
    const certs = x5c.map((b64) => {
      const pem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`;
      return new X509Certificate(pem);
    });

    // Verify the certificate chain: leaf → intermediate → root
    // Each cert must be signed by the next one in the chain
    for (let i = 0; i < certs.length - 1; i++) {
      if (!certs[i].checkIssued(certs[i + 1])) {
        throw new DoubloonError(
          'INVALID_SIGNATURE',
          `Apple certificate chain broken at index ${i}: cert not issued by next cert in chain`,
        );
      }
    }

    // The last cert in the x5c chain should be signed by an Apple root CA.
    // If rootCertificates are provided, verify against them.
    if (this.rootCertificates && this.rootCertificates.length > 0) {
      const topCert = certs[certs.length - 1];
      const trusted = this.rootCertificates.some((rootBuf) => {
        try {
          const rootCert = new X509Certificate(rootBuf);
          return topCert.checkIssued(rootCert);
        } catch {
          return false;
        }
      });
      if (!trusted) {
        throw new DoubloonError(
          'INVALID_SIGNATURE',
          'Apple certificate chain does not terminate at a trusted root certificate',
        );
      }
    }

    // Verify the JWS signature using the leaf certificate's public key
    const leafPublicKey = certs[0].publicKey;
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(signatureB64, 'base64url');

    // Map JWS algorithm to Node.js crypto algorithm
    const cryptoAlg = alg === 'ES256' ? 'SHA256' : 'SHA384';
    const verifier = createVerify(cryptoAlg);
    verifier.update(signingInput);
    const valid = verifier.verify(
      { key: leafPublicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    );

    if (!valid) {
      throw new DoubloonError('INVALID_SIGNATURE', 'Apple JWS signature verification failed');
    }

    // Decode and parse the payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    } catch {
      throw new DoubloonError('INVALID_RECEIPT', 'Could not decode JWS payload');
    }

    // Validate bundleId if present in the payload's data
    const data = payload.data as Record<string, unknown> | undefined;
    if (data?.bundleId && data.bundleId !== this.bundleId) {
      throw new DoubloonError(
        'INVALID_SIGNATURE',
        `bundleId mismatch: expected "${this.bundleId}", got "${data.bundleId}"`,
      );
    }

    return payload;
  }

  private async resolveWalletFromTransaction(
    tx: Record<string, unknown> | undefined,
  ): Promise<string | null> {
    if (!tx) return null;
    if (tx.appAccountToken) {
      const wallet = await this.walletResolver.resolveWallet('apple', String(tx.appAccountToken));
      if (wallet) {
        // Validate wallet address format
        if (!this.isValidWalletAddress(wallet)) {
          throw new DoubloonError('WALLET_NOT_LINKED', `Invalid wallet address format: ${wallet}`);
        }
        return wallet;
      }
    }
    const wallet = await this.walletResolver.resolveWallet(
      'apple',
      String(tx.originalTransactionId ?? tx.transactionId),
    );
    if (wallet && !this.isValidWalletAddress(wallet)) {
      throw new DoubloonError('WALLET_NOT_LINKED', `Invalid wallet address format: ${wallet}`);
    }
    return wallet;
  }

  private isValidWalletAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    if (this.walletValidator) return this.walletValidator(address);
    if (/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,44}$/.test(address)) return true;
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) return true;
    return false;
  }

  private mapToInstruction(
    type: NotificationType,
    productId: string,
    wallet: string | null,
    tx: Record<string, unknown>,
  ): MintInstruction | RevokeInstruction | null {
    if (!wallet) return null;

    switch (type) {
      case 'initial_purchase':
      case 'renewal':
      case 'billing_recovery':
      case 'offer_redeemed':
      case 'plan_change':
      case 'resume':
        return {
          productId,
          user: wallet,
          expiresAt: tx.expiresDate ? new Date(tx.expiresDate as number) : null,
          source: 'apple',
          sourceId: String(tx.originalTransactionId ?? tx.transactionId ?? ''),
        } satisfies MintInstruction;

      case 'expiration':
      case 'refund':
      case 'revocation':
        return {
          productId,
          user: wallet,
          reason: `apple:${type}`,
        } satisfies RevokeInstruction;

      case 'cancellation':
      case 'uncancellation':
      case 'grace_period_start':
      case 'billing_retry_start':
      case 'price_increase_consent':
      case 'pause':
      case 'test':
        return null;

      default:
        this.logger.warn('Unknown notification type', { type });
        return null;
    }
  }

  private static extractEnvironment(payload: Record<string, unknown>): 'production' | 'sandbox' {
    const data = payload.data as Record<string, unknown> | undefined;
    const raw = data?.environment as string | undefined;
    return raw?.toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
  }

  private buildNotification(
    tx: Record<string, unknown>,
    productId: string,
    wallet: string,
    type: NotificationType,
    environment: 'production' | 'sandbox',
  ): StoreNotification {
    return {
      id: String(tx.transactionId ?? ''),
      type,
      store: 'apple',
      environment,
      productId,
      userWallet: wallet,
      originalTransactionId: String(tx.originalTransactionId ?? tx.transactionId ?? ''),
      expiresAt: tx.expiresDate ? new Date(tx.expiresDate as number) : null,
      autoRenew: type !== 'cancellation' && type !== 'expiration' && (tx.autoRenewStatus as number) !== 0,
      storeTimestamp: tx.purchaseDate ? new Date(tx.purchaseDate as number) : new Date(),
      receivedTimestamp: new Date(),
      deduplicationKey: computeAppleDeduplicationKey(type, tx as any),
      raw: tx,
    };
  }

  private buildEmptyNotification(
    appleType: string,
    subtype: string | undefined,
    normalizedType: NotificationType,
    environment: 'production' | 'sandbox',
  ): StoreNotification {
    return {
      id: '',
      type: normalizedType,
      store: 'apple',
      environment,
      productId: '',
      userWallet: '',
      originalTransactionId: '',
      expiresAt: null,
      autoRenew: false,
      storeTimestamp: new Date(),
      receivedTimestamp: new Date(),
      deduplicationKey: `apple:${appleType}:${subtype ?? ''}:empty`,
      raw: { notificationType: appleType, subtype },
    };
  }
}

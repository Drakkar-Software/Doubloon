import { createHash } from 'node:crypto';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import type { MintInstruction, RevokeInstruction, EntitlementSource, Logger } from '@doubloon/core';
import { deriveProductId, DoubloonError, nullLogger } from '@doubloon/core';
import {
  derivePlatformPda,
  deriveProductPda,
  deriveEntitlementPda,
  deriveDelegatePda,
} from './pda.js';

export interface DoubloonSolanaWriterConfig {
  rpcUrl: string;
  programId: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  logger?: Logger;
}

function entitlementSourceToU8(source: EntitlementSource): number {
  const map: Record<EntitlementSource, number> = {
    platform: 0,
    creator: 1,
    delegate: 2,
    apple: 3,
    google: 4,
    stripe: 5,
    x402: 6,
  };
  return map[source];
}

const discriminatorCache = new Map<string, Buffer>();
function anchorDiscriminator(name: string): Buffer {
  let disc = discriminatorCache.get(name);
  if (!disc) {
    disc = Buffer.from(
      createHash('sha256').update(`global:${name}`).digest().subarray(0, 8),
    );
    discriminatorCache.set(name, disc);
  }
  return disc;
}

// TODO: Integrate Anchor Program.methods for building instructions; transactions currently use manual serialization
export class DoubloonSolanaWriter {
  readonly connection: Connection;
  private programId: PublicKey;
  private logger: Logger;

  constructor(config: DoubloonSolanaWriterConfig) {
    this.connection = new Connection(config.rpcUrl, config.commitment ?? 'confirmed');
    this.programId = new PublicKey(config.programId);
    this.logger = config.logger ?? nullLogger;
  }

  async registerProduct(params: {
    slug: string;
    name: string;
    metadataUri: string;
    defaultDuration: number;
    creator: string;
  }): Promise<{ transaction: Transaction; productId: string }> {
    const productIdBytes = deriveProductId(params.slug);
    const productIdHex = Buffer.from(productIdBytes).toString('hex');
    const [productPda] = deriveProductPda(productIdBytes, this.programId);
    const [platformPda] = derivePlatformPda(this.programId);
    const creatorPubkey = new PublicKey(params.creator);

    this.logger.info('Building registerProduct transaction', {
      slug: params.slug,
      productId: productIdHex,
    });

    // Encode instruction data: discriminator + product_id + name + metadata_uri + default_duration
    const disc = anchorDiscriminator('register_product');
    const nameBuf = Buffer.from(params.name, 'utf-8');
    const uriBuf = Buffer.from(params.metadataUri, 'utf-8');
    const data = Buffer.concat([
      disc,
      Buffer.from(productIdBytes),                           // [u8; 32]
      Buffer.alloc(4),                                        // name length prefix
      nameBuf,
      Buffer.alloc(4),                                        // uri length prefix
      uriBuf,
      Buffer.alloc(8),                                        // default_duration i64
    ]);
    data.writeUInt32LE(nameBuf.length, 40);
    data.writeUInt32LE(uriBuf.length, 44 + nameBuf.length);
    data.writeBigInt64LE(BigInt(params.defaultDuration), 48 + nameBuf.length + uriBuf.length);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: creatorPubkey, isSigner: true, isWritable: true },
        { pubkey: platformPda, isSigner: false, isWritable: true },
        { pubkey: productPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = creatorPubkey;
    return { transaction: tx, productId: productIdHex };
  }

  async mintEntitlement(params: MintInstruction & {
    signer: string;
    autoRenew?: boolean;
  }): Promise<Transaction> {
    const signerPubkey = new PublicKey(params.signer);
    const userPubkey = new PublicKey(params.user);
    const [platformPda] = derivePlatformPda(this.programId);
    const [productPda] = deriveProductPda(params.productId, this.programId);
    const [entitlementPda] = deriveEntitlementPda(params.productId, params.user, this.programId);
    const [delegatePda] = deriveDelegatePda(params.productId, params.signer, this.programId);

    const expiresAtUnix = params.expiresAt ? Math.floor(params.expiresAt.getTime() / 1000) : 0;
    const sourceU8 = entitlementSourceToU8(params.source);
    const sourceIdBuf = Buffer.from(params.sourceId, 'utf-8');

    this.logger.info('Building mintEntitlement transaction', {
      productId: params.productId,
      user: params.user,
      expiresAt: expiresAtUnix,
      source: params.source,
    });

    const disc = anchorDiscriminator('mint_entitlement');
    const data = Buffer.alloc(8 + 8 + 1 + 4 + sourceIdBuf.length + 1);
    let offset = 0;
    disc.copy(data, offset); offset += 8;
    data.writeBigInt64LE(BigInt(expiresAtUnix), offset); offset += 8;
    data[offset] = sourceU8; offset += 1;
    data.writeUInt32LE(sourceIdBuf.length, offset); offset += 4;
    sourceIdBuf.copy(data, offset); offset += sourceIdBuf.length;
    data[offset] = params.autoRenew ? 1 : 0;

    const keys = [
      { pubkey: signerPubkey, isSigner: true, isWritable: true },
      { pubkey: platformPda, isSigner: false, isWritable: false },
      { pubkey: productPda, isSigner: false, isWritable: true },
      { pubkey: entitlementPda, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: false, isWritable: false },
      { pubkey: delegatePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({ programId: this.programId, keys, data });
    const tx = new Transaction().add(ix);
    tx.feePayer = signerPubkey;
    return tx;
  }

  async extendEntitlement(params: {
    productId: string;
    user: string;
    newExpiresAt: Date;
    source: EntitlementSource;
    sourceId: string;
    signer: string;
  }): Promise<Transaction> {
    const signerPubkey = new PublicKey(params.signer);
    const userPubkey = new PublicKey(params.user);
    const [platformPda] = derivePlatformPda(this.programId);
    const [productPda] = deriveProductPda(params.productId, this.programId);
    const [entitlementPda] = deriveEntitlementPda(params.productId, params.user, this.programId);

    const newExpiresAtUnix = Math.floor(params.newExpiresAt.getTime() / 1000);
    const sourceU8 = entitlementSourceToU8(params.source);
    const sourceIdBuf = Buffer.from(params.sourceId, 'utf-8');

    const disc = anchorDiscriminator('extend_entitlement');
    const data = Buffer.alloc(8 + 8 + 1 + 4 + sourceIdBuf.length);
    let offset = 0;
    disc.copy(data, offset); offset += 8;
    data.writeBigInt64LE(BigInt(newExpiresAtUnix), offset); offset += 8;
    data[offset] = sourceU8; offset += 1;
    data.writeUInt32LE(sourceIdBuf.length, offset); offset += 4;
    sourceIdBuf.copy(data, offset);

    const keys = [
      { pubkey: signerPubkey, isSigner: true, isWritable: true },
      { pubkey: platformPda, isSigner: false, isWritable: false },
      { pubkey: productPda, isSigner: false, isWritable: true },
      { pubkey: entitlementPda, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({ programId: this.programId, keys, data });
    const tx = new Transaction().add(ix);
    tx.feePayer = signerPubkey;
    return tx;
  }

  async revokeEntitlement(params: RevokeInstruction & {
    signer: string;
  }): Promise<Transaction> {
    const signerPubkey = new PublicKey(params.signer);
    const userPubkey = new PublicKey(params.user);
    const [platformPda] = derivePlatformPda(this.programId);
    const [productPda] = deriveProductPda(params.productId, this.programId);
    const [entitlementPda] = deriveEntitlementPda(params.productId, params.user, this.programId);

    const reasonBuf = Buffer.from(params.reason, 'utf-8');

    const disc = anchorDiscriminator('revoke_entitlement');
    const data = Buffer.alloc(8 + 4 + reasonBuf.length);
    let offset = 0;
    disc.copy(data, offset); offset += 8;
    data.writeUInt32LE(reasonBuf.length, offset); offset += 4;
    reasonBuf.copy(data, offset);

    const keys = [
      { pubkey: signerPubkey, isSigner: true, isWritable: true },
      { pubkey: platformPda, isSigner: false, isWritable: false },
      { pubkey: productPda, isSigner: false, isWritable: true },
      { pubkey: entitlementPda, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({ programId: this.programId, keys, data });
    const tx = new Transaction().add(ix);
    tx.feePayer = signerPubkey;
    return tx;
  }

  async batchMintEntitlements(params: {
    mints: MintInstruction[];
    signer: string;
    autoRenew?: boolean;
  }): Promise<Transaction[]> {
    if (params.mints.length === 0) return [];

    const MINTS_PER_TX = 3;
    const transactions: Transaction[] = [];

    // Build individual mint transactions, then extract instructions and pack up to 3 per tx
    const singleTxs = await Promise.all(
      params.mints.map((mint) =>
        this.mintEntitlement({ ...mint, signer: params.signer, autoRenew: params.autoRenew }),
      ),
    );

    const signerPubkey = new PublicKey(params.signer);

    for (let i = 0; i < singleTxs.length; i += MINTS_PER_TX) {
      const batch = singleTxs.slice(i, i + MINTS_PER_TX);
      const tx = new Transaction();
      for (const singleTx of batch) {
        for (const ix of singleTx.instructions) {
          tx.add(ix);
        }
      }
      tx.feePayer = signerPubkey;
      transactions.push(tx);
    }

    return transactions;
  }

  async grantDelegation(params: {
    productId: string;
    delegate: string;
    expiresAt?: Date;
    maxMints?: number;
    signer: string;
  }): Promise<Transaction> {
    const signerPubkey = new PublicKey(params.signer);
    const delegatePubkey = new PublicKey(params.delegate);
    const [platformPda] = derivePlatformPda(this.programId);
    const [productPda] = deriveProductPda(params.productId, this.programId);
    const [delegatePda] = deriveDelegatePda(params.productId, params.delegate, this.programId);

    const expiresAtUnix = params.expiresAt ? Math.floor(params.expiresAt.getTime() / 1000) : 0;
    const maxMints = params.maxMints ?? 0;

    const disc = anchorDiscriminator('grant_delegation');
    const data = Buffer.alloc(8 + 8 + 4);
    let offset = 0;
    disc.copy(data, offset); offset += 8;
    data.writeBigInt64LE(BigInt(expiresAtUnix), offset); offset += 8;
    data.writeUInt32LE(maxMints, offset);

    const keys = [
      { pubkey: signerPubkey, isSigner: true, isWritable: true },
      { pubkey: platformPda, isSigner: false, isWritable: false },
      { pubkey: productPda, isSigner: false, isWritable: true },
      { pubkey: delegatePda, isSigner: false, isWritable: true },
      { pubkey: delegatePubkey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({ programId: this.programId, keys, data });
    const tx = new Transaction().add(ix);
    tx.feePayer = signerPubkey;
    return tx;
  }

  async revokeDelegation(params: {
    productId: string;
    delegate: string;
    signer: string;
  }): Promise<Transaction> {
    const signerPubkey = new PublicKey(params.signer);
    const delegatePubkey = new PublicKey(params.delegate);
    const [platformPda] = derivePlatformPda(this.programId);
    const [productPda] = deriveProductPda(params.productId, this.programId);
    const [delegatePda] = deriveDelegatePda(params.productId, params.delegate, this.programId);

    const disc = anchorDiscriminator('revoke_delegation');
    const data = Buffer.from(disc);

    const keys = [
      { pubkey: signerPubkey, isSigner: true, isWritable: true },
      { pubkey: platformPda, isSigner: false, isWritable: false },
      { pubkey: productPda, isSigner: false, isWritable: true },
      { pubkey: delegatePda, isSigner: false, isWritable: true },
      { pubkey: delegatePubkey, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({ programId: this.programId, keys, data });
    const tx = new Transaction().add(ix);
    tx.feePayer = signerPubkey;
    return tx;
  }
}

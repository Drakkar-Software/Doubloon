import type { MetadataStore, ProductMetadata } from '@doubloon/storage';

/**
 * Minimal S3-compatible client interface.
 * Works with AWS SDK v3 S3Client or any S3-compatible API (MinIO, R2, etc.).
 */
export interface S3Like {
  getObject(params: { Bucket: string; Key: string }): Promise<{ Body?: { transformToString(): Promise<string> } }>;
  putObject(params: { Bucket: string; Key: string; Body: string | Uint8Array; ContentType?: string }): Promise<unknown>;
  deleteObject(params: { Bucket: string; Key: string }): Promise<unknown>;
  listObjectsV2(params: { Bucket: string; Prefix: string; MaxKeys?: number; ContinuationToken?: string }): Promise<{
    Contents?: { Key?: string }[];
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  }>;
}

export interface S3MetadataStoreConfig {
  client: S3Like;
  bucket: string;
  /** Key prefix for product metadata. Defaults to "products/" */
  prefix?: string;
  /** Key prefix for product assets. Defaults to "assets/" */
  assetsPrefix?: string;
  /** Public URL base for assets (e.g., CDN URL). If not set, returns s3:// URIs. */
  publicUrlBase?: string;
}

/**
 * S3-backed MetadataStore for product metadata and binary assets.
 */
function validateS3Key(value: string, label: string): void {
  if (/\.\./.test(value) || value.startsWith('/')) {
    throw new Error(`Invalid ${label}: must not contain ".." or start with "/"`);
  }
}

export class S3MetadataStore implements MetadataStore {
  private client: S3Like;
  private bucket: string;
  private prefix: string;
  private assetsPrefix: string;
  private publicUrlBase?: string;

  constructor(config: S3MetadataStoreConfig) {
    this.client = config.client;
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? 'products/';
    this.assetsPrefix = config.assetsPrefix ?? 'assets/';
    this.publicUrlBase = config.publicUrlBase;
  }

  async getProduct(productId: string): Promise<ProductMetadata | null> {
    validateS3Key(productId, 'productId');
    try {
      const resp = await this.client.getObject({
        Bucket: this.bucket,
        Key: `${this.prefix}${productId}.json`,
      });
      if (!resp.Body) return null;
      const raw = await resp.Body.transformToString();
      return JSON.parse(raw) as ProductMetadata;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async putProduct(metadata: ProductMetadata): Promise<{ uri: string }> {
    validateS3Key(metadata.productId, 'productId');
    const key = `${this.prefix}${metadata.productId}.json`;
    await this.client.putObject({
      Bucket: this.bucket,
      Key: key,
      Body: JSON.stringify(metadata),
      ContentType: 'application/json',
    });
    return { uri: `s3://${this.bucket}/${key}` };
  }

  async deleteProduct(productId: string): Promise<void> {
    validateS3Key(productId, 'productId');
    await this.client.deleteObject({
      Bucket: this.bucket,
      Key: `${this.prefix}${productId}.json`,
    });
  }

  async listProducts(opts?: { creator?: string; limit?: number; offset?: number }): Promise<ProductMetadata[]> {
    const products: ProductMetadata[] = [];
    let continuationToken: string | undefined;
    const maxKeys = opts?.limit ?? 1000;

    do {
      const resp = await this.client.listObjectsV2({
        Bucket: this.bucket,
        Prefix: this.prefix,
        MaxKeys: maxKeys,
        ContinuationToken: continuationToken,
      });

      for (const obj of resp.Contents ?? []) {
        if (!obj.Key || !obj.Key.endsWith('.json')) continue;
        const product = await this.getProduct(
          obj.Key.slice(this.prefix.length, -5),
        );
        if (!product) continue;
        if (opts?.creator && (product as unknown as Record<string, unknown>).creator !== opts.creator) continue;
        products.push(product);
      }

      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken && products.length < maxKeys);

    const offset = opts?.offset ?? 0;
    return products.slice(offset, offset + maxKeys);
  }

  async putAsset(
    productId: string,
    name: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<{ url: string }> {
    validateS3Key(productId, 'productId');
    validateS3Key(name, 'asset name');
    const key = `${this.assetsPrefix}${productId}/${name}`;
    await this.client.putObject({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
    });
    const url = this.publicUrlBase
      ? `${this.publicUrlBase}/${key}`
      : `s3://${this.bucket}/${key}`;
    return { url };
  }

  async getAssetUrl(productId: string, name: string): Promise<string | null> {
    validateS3Key(productId, 'productId');
    validateS3Key(name, 'asset name');
    const key = `${this.assetsPrefix}${productId}/${name}`;
    try {
      await this.client.getObject({ Bucket: this.bucket, Key: key });
      return this.publicUrlBase
        ? `${this.publicUrlBase}/${key}`
        : `s3://${this.bucket}/${key}`;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }
}

function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey') return true;
    if (typeof e.$metadata === 'object' && e.$metadata !== null) {
      const meta = e.$metadata as Record<string, unknown>;
      if (meta.httpStatusCode === 404) return true;
    }
  }
  return false;
}

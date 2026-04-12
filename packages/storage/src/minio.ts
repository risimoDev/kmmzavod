import { Client as MinioClient } from 'minio';
import * as fs from 'fs';
import type { IStorageClient, UploadOptions } from './client';

export class MinioStorageClient implements IStorageClient {
  private client: MinioClient;
  private bucket: string;
  private _publicBaseUrl: string | undefined;

  constructor(opts: {
    endPoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
    bucket: string;
    publicBaseUrl?: string;
  }) {
    this.client = new MinioClient({
      endPoint: opts.endPoint,
      port: opts.port,
      useSSL: opts.useSSL,
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
    });
    this.bucket = opts.bucket;
    this._publicBaseUrl = opts.publicBaseUrl?.replace(/\/+$/, '');
  }

  /** Ensure the configured bucket exists (call once at startup). */
  async ensureBucket(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
    }
    // If public proxy is configured, set bucket policy to allow anonymous read
    if (this._publicBaseUrl) {
      const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${this.bucket}/*`],
        }],
      });
      await this.client.setBucketPolicy(this.bucket, policy);
    }
  }

  async uploadFile(key: string, localPath: string, opts?: UploadOptions): Promise<void> {
    await this.client.fPutObject(this.bucket, key, localPath, {
      'Content-Type': opts?.contentType ?? 'application/octet-stream',
      ...opts?.metadata,
    });
  }

  async uploadBuffer(key: string, buffer: Buffer, opts?: UploadOptions): Promise<void> {
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': opts?.contentType ?? 'application/octet-stream',
      ...opts?.metadata,
    });
  }

  async downloadFile(key: string, localPath: string): Promise<void> {
    await this.client.fGetObject(this.bucket, key, localPath);
  }

  async presignedUrl(key: string, expirySeconds = 3600): Promise<string> {
    // If a public proxy URL is configured, return a clean public URL without signatures.
    // The proxy (nginx) handles auth to MinIO internally.
    if (this._publicBaseUrl) {
      return `${this._publicBaseUrl}/${this.bucket}/${key}`;
    }
    return this.client.presignedGetObject(this.bucket, key, expirySeconds);
  }

  /** Public URL for a key (no signature). Requires publicBaseUrl to be configured. */
  publicUrl(key: string): string {
    if (!this._publicBaseUrl) {
      throw new Error('publicBaseUrl is not configured — set MINIO_PUBLIC_URL');
    }
    return `${this._publicBaseUrl}/${this.bucket}/${key}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async listPrefix(prefix: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const keys: string[] = [];
      const stream = this.client.listObjectsV2(this.bucket, prefix, true);
      stream.on('data', (obj) => { if (obj.name) keys.push(obj.name); });
      stream.on('error', reject);
      stream.on('end', () => resolve(keys));
    });
  }
}

import { Client as MinioClient } from 'minio';
import * as fs from 'fs';
import type { IStorageClient, UploadOptions } from './client';

export class MinioStorageClient implements IStorageClient {
  private client: MinioClient;
  private bucket: string;

  constructor(opts: {
    endPoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
    bucket: string;
  }) {
    this.client = new MinioClient({
      endPoint: opts.endPoint,
      port: opts.port,
      useSSL: opts.useSSL,
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
    });
    this.bucket = opts.bucket;
  }

  /** Ensure the configured bucket exists (call once at startup). */
  async ensureBucket(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
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
    return this.client.presignedGetObject(this.bucket, key, expirySeconds);
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

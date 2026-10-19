import { Client as MinioClient } from 'minio';
import * as fs from 'fs';
import type { Readable } from 'node:stream';
import type { IStorageClient, UploadOptions } from './client';

export class MinioStorageClient implements IStorageClient {
  private client: MinioClient;
  private bucket: string;
  private _publicBaseUrl: string | undefined;
  private _region: string;
  /**
   * Signs GET URLs for the public host (MINIO_PUBLIC_URL, e.g. https://example.com/storage).
   * SigV4 covers the Host header, so URLs must be signed for the host the browser hits;
   * nginx then forwards that Host unchanged to MinIO. Never used for network calls.
   */
  private publicSigner: MinioClient | undefined;
  private publicPathPrefix = '';

  constructor(opts: {
    endPoint: string;
    port?: number;
    useSSL?: boolean;
    accessKey: string;
    secretKey: string;
    bucket: string;
    publicBaseUrl?: string;
    region?: string;
  }) {
    let cleanEndpoint = (opts.endPoint || 'localhost').trim();
    const hasHttps = cleanEndpoint.startsWith('https://');
    cleanEndpoint = cleanEndpoint.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

    let port = opts.port;
    if (cleanEndpoint.includes(':')) {
      const parts = cleanEndpoint.split(':');
      cleanEndpoint = parts[0];
      const parsedPort = parseInt(parts[1], 10);
      if (!isNaN(parsedPort) && parsedPort > 0) {
        port = parsedPort;
      }
    }

    const useSSL = opts.useSSL !== undefined ? opts.useSSL : (hasHttps || port === 443);
    if (!port || (port === 9000 && (useSSL || hasHttps))) {
      // If secure (HTTPS) and port is not explicitly set or was defaulted to 9000, use 443
      port = useSSL ? 443 : 9000;
    }

    this._region = opts.region || 'us-east-1';
    this.client = new MinioClient({
      endPoint: cleanEndpoint,
      port,
      useSSL,
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
      region: this._region,
      partSize: 10 * 1024 * 1024, // 10MB chunks for streaming multipart uploads (prevents memory bloat / OOM)
    });
    this.bucket = opts.bucket;
    this._publicBaseUrl = opts.publicBaseUrl?.replace(/\/+$/, '');
    if (this._publicBaseUrl) {
      try {
        const u = new URL(this._publicBaseUrl);
        const publicSSL = u.protocol === 'https:';
        this.publicSigner = new MinioClient({
          endPoint: u.hostname,
          port: u.port ? Number(u.port) : publicSSL ? 443 : 80,
          useSSL: publicSSL,
          accessKey: opts.accessKey,
          secretKey: opts.secretKey,
          region: this._region, // known region → presigning needs no network round-trip
          pathStyle: true,
        });
        this.publicPathPrefix = u.pathname.replace(/\/+$/, '');
      } catch {
        console.warn(`[storage] MINIO_PUBLIC_URL '${this._publicBaseUrl}' is not a valid URL — falling back to direct presigned URLs`);
        this._publicBaseUrl = undefined;
      }
    }

    if (this._publicBaseUrl && !['minio', 'localhost', '127.0.0.1'].includes(cleanEndpoint)) {
      if (this._publicBaseUrl.includes('/storage')) {
        console.warn(`[storage] Warning: MINIO_PUBLIC_URL is set to '${this._publicBaseUrl}', but external S3 (${cleanEndpoint}) is used. This will route media requests to local MinIO instead of ${cleanEndpoint}. Clear MINIO_PUBLIC_URL to use direct presigned S3 URLs.`);
      }
    }
  }

  /** Ensure the configured bucket exists (call once at startup). */
  async ensureBucket(): Promise<void> {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket, this._region);
      }
      // Older versions made the whole bucket anonymously readable when MINIO_PUBLIC_URL
      // was set (all tenants' media, APKs, footage). Media is now served via signed URLs,
      // so drop that anonymous-read policy if it is still in place.
      await this.removeLegacyPublicReadPolicy();
    } catch (err: any) {
      // In external cloud S3 (AWS, Timeweb, Selectel, Yandex), bucketExists or makeBucket
      // might fail with AccessDenied if credentials have scoped object permissions.
      // We log a warning instead of crashing the server on startup.
      console.warn(`[storage] Notice: ensureBucket('${this.bucket}') skipped/warn:`, err?.message || err);
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

  async uploadStream(key: string, stream: Readable, size?: number, opts?: UploadOptions): Promise<void> {
    // When size is undefined, minio uploads via multipart with an internal part size.
    await this.client.putObject(this.bucket, key, stream, size, {
      'Content-Type': opts?.contentType ?? 'application/octet-stream',
      ...opts?.metadata,
    });
  }

  async downloadFile(key: string, localPath: string): Promise<void> {
    await this.client.fGetObject(this.bucket, key, localPath);
  }

  async presignedUrl(key: string, expirySeconds = 3600): Promise<string> {
    if (this.publicSigner) {
      // Signed for the public host; the path prefix (/storage) is stripped by nginx before
      // the request reaches MinIO, so it is added only after signing.
      const signed = new URL(await this.publicSigner.presignedGetObject(this.bucket, key, expirySeconds));
      signed.pathname = `${this.publicPathPrefix}${signed.pathname}`;
      return signed.toString();
    }
    return this.client.presignedGetObject(this.bucket, key, expirySeconds);
  }

  private async removeLegacyPublicReadPolicy(): Promise<void> {
    let raw: string;
    try {
      raw = await this.client.getBucketPolicy(this.bucket);
    } catch {
      return; // no policy set
    }
    try {
      const policy = JSON.parse(raw) as { Statement?: Array<Record<string, unknown>> };
      const isLegacyPublicRead = (policy.Statement ?? []).some((st) => {
        const principal = JSON.stringify(st.Principal ?? '');
        const action = JSON.stringify(st.Action ?? '');
        return st.Effect === 'Allow' && principal.includes('*') && action.includes('s3:GetObject');
      });
      if (isLegacyPublicRead) {
        await this.client.setBucketPolicy(this.bucket, '');
        console.warn(`[storage] Removed anonymous-read policy from bucket '${this.bucket}' (media is served via signed URLs now)`);
      }
    } catch (err: any) {
      console.warn('[storage] Could not inspect/remove bucket policy:', err?.message || err);
    }
  }

  async presignedPutUrl(key: string, _contentType?: string, expirySeconds = 3600): Promise<string> {
    return this.client.presignedPutObject(this.bucket, key, expirySeconds);
  }

  /**
   * Unsigned URL for a key. Only works for objects that are explicitly public — the bucket
   * itself is private, so prefer presignedUrl().
   */
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

// Storage client interface — swap MinIO ↔ S3 without touching workers

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface IStorageClient {
  /** Upload from a local file path */
  uploadFile(key: string, localPath: string, opts?: UploadOptions): Promise<void>;
  /** Upload from a Buffer */
  uploadBuffer(key: string, buffer: Buffer, opts?: UploadOptions): Promise<void>;
  /** Download to a local file path */
  downloadFile(key: string, localPath: string): Promise<void>;
  /** Generate a pre-signed GET URL (default 1h TTL) */
  presignedUrl(key: string, expirySeconds?: number): Promise<string>;
  /** Ensure bucket exists (call once at startup). */
  ensureBucket(): Promise<void>;
  /** Check if an object exists */
  exists(key: string): Promise<boolean>;
  /** Delete an object */
  delete(key: string): Promise<void>;
}

/**
 * Tenant ownership of MinIO object keys.
 *
 * All tenants share ONE bucket, so a key coming from the client (product images,
 * BGM tracks, editor config, ...) must be proven to live under the caller's own
 * `tenants/<tenantId>/` prefix before we presign it or hand it to a worker.
 * Every key produced by the API's own upload endpoints (StoragePaths.*) starts
 * with that prefix.
 */

/**
 * Shared read-only key prefixes any tenant may reference. Currently empty: the
 * global `bgm/` library (StoragePaths.bgmPrefix) is only listed server-side by
 * the video-compose worker and is never exposed to clients as a selectable key.
 * Add a prefix here only if an endpoint starts offering shared files to users.
 */
export const SHARED_READ_PREFIXES: readonly string[] = [];

function isCleanKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 1024 &&
    !key.includes('..') &&
    !key.includes('//') &&
    !key.includes('\\') &&
    !key.includes('\0') &&
    !key.startsWith('/')
  );
}

export function isOwnStorageKey(tenantId: string, key: string): boolean {
  if (typeof key !== 'string' || !tenantId || !isCleanKey(key)) return false;
  if (key.startsWith(`tenants/${tenantId}/`)) return true;
  return SHARED_READ_PREFIXES.some((p) => key.startsWith(p));
}

export class StorageKeyError extends Error {
  statusCode = 400;
  constructor(message = 'Недопустимый ключ файла') {
    super(message);
    this.name = 'BadRequest';
  }
}

/** Throws a 400 (mapped by the global error handler) if the key is not the tenant's. */
export function assertOwnStorageKey(tenantId: string, key: string, field = 'key'): void {
  if (!isOwnStorageKey(tenantId, key)) {
    throw new StorageKeyError(`Недопустимый ключ файла (${field})`);
  }
}

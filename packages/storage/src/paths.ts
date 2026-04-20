// Canonical storage path builders — used by all services.
// Changing these functions changes paths everywhere uniformly.

/** Strip path traversal sequences and dangerous characters from filenames */
function sanitizeFilename(name: string): string {
  return name
    .replace(/\.\./g, '')       // remove ..
    .replace(/[\/\\]/g, '_')    // replace path separators
    .replace(/^\.+/, '')        // no leading dots
    .slice(0, 255)              // cap length
    || 'unnamed';
}

export const StoragePaths = {
  /** Original user-uploaded assets (product images, logos, audio) */
  asset: (tenantId: string, assetId: string, filename: string) =>
    `tenants/${tenantId}/assets/${assetId}/${sanitizeFilename(filename)}`,

  /** Per-scene AI-generated outputs */
  sceneAvatar: (tenantId: string, sceneId: string) =>
    `tenants/${tenantId}/scenes/${sceneId}/avatar.mp4`,

  sceneClip: (tenantId: string, sceneId: string) =>
    `tenants/${tenantId}/scenes/${sceneId}/clip.mp4`,

  sceneImage: (tenantId: string, sceneId: string) =>
    `tenants/${tenantId}/scenes/${sceneId}/product.png`,

  /** Generated ASS subtitle file */
  subtitles: (tenantId: string, jobId: string) =>
    `tenants/${tenantId}/subtitles/${jobId}/subs.ass`,

  /** Final composed video */
  finalVideo: (tenantId: string, jobId: string) =>
    `tenants/${tenantId}/videos/${jobId}/final.mp4`,

  /** Ephemeral working files — auto-purged by MinIO lifecycle rule (TTL 24h) */
  temp: (tenantId: string, jobId: string, filename: string) =>
    `tenants/${tenantId}/temp/${jobId}/${sanitizeFilename(filename)}`,

  /** Global BGM library prefix (admin-uploaded background music tracks) */
  bgmPrefix: () => 'bgm/',
} as const;

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

  /** Combined avatar video (all avatar scenes merged into one HeyGen render) */
  jobCombinedAvatar: (tenantId: string, jobId: string) =>
    `tenants/${tenantId}/jobs/${jobId}/combined_avatar.mp4`,

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

  /** Per-tenant background-music library prefix (uniquify music) */
  bgmTenantPrefix: (tenantId: string) => `tenants/${tenantId}/bgm/`,

  /** A single uploaded background-music track */
  bgmTrack: (tenantId: string, trackId: string, filename: string) =>
    `tenants/${tenantId}/bgm/${trackId}/${sanitizeFilename(filename)}`,

  /** Uploaded source videos for uniquification */
  sourceVideo: (tenantId: string, sourceVideoId: string, filename: string) =>
    `tenants/${tenantId}/source-videos/${sourceVideoId}/${sanitizeFilename(filename)}`,

  /** Uniquified variant output */
  uniqueVariant: (tenantId: string, uniquifyJobId: string, variantId: string) =>
    `tenants/${tenantId}/uniquify/${uniquifyJobId}/${variantId}.mp4`,

  /** Uniquified variant thumbnail */
  uniqueVariantThumb: (tenantId: string, uniquifyJobId: string, variantId: string) =>
    `tenants/${tenantId}/uniquify/${uniquifyJobId}/${variantId}_thumb.jpg`,
} as const;

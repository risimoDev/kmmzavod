// Canonical storage path builders — used by all services.
// Changing these functions changes paths everywhere uniformly.

export const StoragePaths = {
  /** Original user-uploaded assets (product images, logos, audio) */
  asset: (tenantId: string, assetId: string, filename: string) =>
    `tenants/${tenantId}/assets/${assetId}/${filename}`,

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
    `tenants/${tenantId}/temp/${jobId}/${filename}`,
} as const;

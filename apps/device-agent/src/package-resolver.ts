/**
 * Dynamic Package Resolver for Android Farm Boards.
 *
 * Verifies and resolves the REAL package names installed on physical phones:
 *  - TikTok: com.zhiliaoapp.musically, com.ss.android.ugc.trill, com.zhiliaoapp.musically.go, com.ss.android.ugc.aweme
 *  - Instagram: com.instagram.android, com.instagram.lite
 *  - Wildberries: com.wildberries.ru
 *  - YouTube: com.google.android.youtube, com.google.android.apps.youtube.mango
 *
 * Automatically detects cloned apps, Lite editions, regional builds and caches
 * results per board to avoid excessive ADB roundtrips.
 */
import type { Logger } from 'pino';
import type { AdbClient } from './adb-client';

export type SupportedPlatform = 'tiktok' | 'instagram' | 'wildberries' | 'youtube_shorts';

export interface ResolveResult {
  installed: boolean;
  packageName?: string;
  platform: SupportedPlatform;
  allFound: string[];
  candidates: string[];
  error?: string;
}

export const PLATFORM_CANDIDATES: Record<SupportedPlatform, string[]> = {
  tiktok: [
    'com.zhiliaoapp.musically',
    'com.ss.android.ugc.trill',
    'com.zhiliaoapp.musically.go',
    'com.ss.android.ugc.aweme',
  ],
  instagram: [
    'com.instagram.android',
    'com.instagram.lite',
  ],
  wildberries: [
    'com.wildberries.ru',
  ],
  youtube_shorts: [
    'com.google.android.youtube',
    'com.google.android.apps.youtube.mango',
  ],
};

export class PackageResolver {
  private cache = new Map<string, { packages: string[]; timestamp: number }>();
  private readonly CACHE_TTL_MS = 120_000; // 2 minutes

  constructor(
    private readonly adb: AdbClient,
    private readonly logger: Logger,
  ) {}

  /** Clear cached packages for a device (e.g. after installing or uninstalling an APK). */
  invalidate(deviceId?: string): void {
    if (deviceId) {
      this.cache.delete(deviceId);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Retrieve all installed package names on the board (cached).
   */
  async getInstalledPackages(deviceId: string, forceRefresh = false): Promise<string[]> {
    const cached = this.cache.get(deviceId);
    if (!forceRefresh && cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.packages;
    }

    try {
      const raw = await this.adb.shell(deviceId, 'pm list packages', 20_000);
      const packages = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('package:'))
        .map((l) => l.slice(8).trim())
        .filter(Boolean);

      this.cache.set(deviceId, { packages, timestamp: Date.now() });
      return packages;
    } catch (err: any) {
      this.logger.warn({ deviceId, err: err.message }, 'package-resolver: failed to fetch pm list packages');
      return cached?.packages ?? [];
    }
  }

  /**
   * Resolve the active package name for a specific social or marketplace app on the board.
   */
  async resolve(deviceId: string, platform: SupportedPlatform, forceRefresh = false): Promise<ResolveResult> {
    const candidates = PLATFORM_CANDIDATES[platform] || [];
    const installed = await this.getInstalledPackages(deviceId, forceRefresh);

    // 1. Exact candidate match (order of preference)
    for (const cand of candidates) {
      if (installed.includes(cand)) {
        return {
          installed: true,
          packageName: cand,
          platform,
          allFound: installed.filter((p) => candidates.includes(p)),
          candidates,
        };
      }
    }

    // 2. Fuzzy match for clones or regional forks
    const fuzzy = installed.filter((p) => {
      const lower = p.toLowerCase();
      if (platform === 'tiktok') return lower.includes('musically') || lower.includes('trill') || lower.includes('tiktok');
      if (platform === 'instagram') return lower.includes('instagram');
      if (platform === 'wildberries') return lower.includes('wildberries');
      if (platform === 'youtube_shorts') return lower.includes('youtube');
      return false;
    });

    if (fuzzy.length > 0) {
      return {
        installed: true,
        packageName: fuzzy[0],
        platform,
        allFound: fuzzy,
        candidates,
      };
    }

    return {
      installed: false,
      platform,
      allFound: [],
      candidates,
      error: `Приложение ${platform} не установлено на плате ${deviceId} (ожидались: ${candidates.join(', ')})`,
    };
  }

  /**
   * Check status of all supported platforms on the device in one pass.
   */
  async checkAllPlatforms(deviceId: string): Promise<Record<SupportedPlatform, ResolveResult>> {
    const installed = await this.getInstalledPackages(deviceId);
    const result = {} as Record<SupportedPlatform, ResolveResult>;

    const platforms: SupportedPlatform[] = ['tiktok', 'instagram', 'wildberries', 'youtube_shorts'];
    for (const p of platforms) {
      const candidates = PLATFORM_CANDIDATES[p];
      const match = candidates.find((c) => installed.includes(c)) ||
        installed.find((pkg) => {
          const l = pkg.toLowerCase();
          if (p === 'tiktok') return l.includes('musically') || l.includes('trill');
          if (p === 'instagram') return l.includes('instagram');
          if (p === 'wildberries') return l.includes('wildberries');
          if (p === 'youtube_shorts') return l.includes('youtube');
          return false;
        });

      result[p] = {
        installed: Boolean(match),
        packageName: match,
        platform: p,
        allFound: match ? [match] : [],
        candidates,
        error: match ? undefined : `Не установлено (требуется ${candidates[0]})`,
      };
    }

    return result;
  }
}

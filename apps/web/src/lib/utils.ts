import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Public profile URL for a farm account (best-effort per platform). */
export function accountUrl(platform: string, accountName: string): string | null {
  const n = accountName?.trim();
  if (!n) return null;
  switch (platform) {
    case "tiktok":         return `https://www.tiktok.com/@${n.replace(/^@/, "")}`;
    case "instagram":      return `https://www.instagram.com/${n}`;
    case "youtube_shorts": return `https://www.youtube.com/@${n.replace(/^@/, "")}`;
    default:                return null; // postbridge = numeric id, no public URL
  }
}

/** Direct URL to a published post, when the platform gives us a usable id. */
export function postUrl(
  platform: string,
  accountName: string,
  externalPostId: string | null | undefined,
): string | null {
  if (!externalPostId) return null;
  const n = accountName?.replace(/^@/, "").trim();
  switch (platform) {
    case "instagram":      return `https://www.instagram.com/reel/${externalPostId}/`;
    case "youtube_shorts": return `https://www.youtube.com/shorts/${externalPostId}`;
    case "tiktok":
      // tiktok-uploader rarely returns a real id; link to the video only if numeric.
      return /^\d+$/.test(externalPostId) && n
        ? `https://www.tiktok.com/@${n}/video/${externalPostId}`
        : null;
    default:                return null;
  }
}

export function relativeTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

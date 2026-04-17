"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  LoadingSpinner,
  Badge,
} from "@/components/ui/primitives";
import { VideoCard } from "@/components/ui/composite";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime } from "@/lib/utils";
import { videosApi, getAccessToken, type Video, type Pagination } from "@/lib/api";
import { cn } from "@/lib/utils";

const STATUSES = [
  { value: "", label: "All" },
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

export default function VideosPage() {
  return (
    <Suspense
      fallback={
        <>
          <TopBar title="Videos" />
          <main className="flex-1 flex items-center justify-center">
            <LoadingSpinner size={32} />
          </main>
        </>
      }
    >
      <VideosContent />
    </Suspense>
  );
}

function VideosContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [videos, setVideos] = useState<Video[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const statusFilter = searchParams.get("status") ?? "";
  const page = Number(searchParams.get("page") ?? "1");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await videosApi.list({
        status: statusFilter || undefined,
        page,
        limit: 18,
      });
      setVideos(res.data);
      setPagination(res.pagination);
    } catch (e: any) {
      setError(e.message ?? "Failed to load videos");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace("/login");
      return;
    }
    load();
  }, [load, router]);

  const setFilter = (status: string) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    router.push(`/videos${params.toString() ? `?${params}` : ""}`);
  };

  const goToPage = (p: number) => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (p > 1) params.set("page", String(p));
    router.push(`/videos${params.toString() ? `?${params}` : ""}`);
  };

  return (
    <>
      <TopBar
        title="Videos"
        actions={
          <Link href="/create">
            <Button variant="primary" size="sm">
              <PlusIcon /> Create
            </Button>
          </Link>
        }
      />

      <main className="flex-1 p-6 space-y-5 animate-slide-up">
        {/* Filter tabs */}
        <div className="flex gap-2">
          {STATUSES.map((s) => (
            <button
              key={s.value}
              onClick={() => setFilter(s.value)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                statusFilter === s.value
                  ? "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30"
                  : "bg-surface-2 text-text-secondary hover:text-text-primary hover:bg-surface-3"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <LoadingSpinner size={32} />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <p className="text-text-secondary text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        ) : videos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <p className="text-text-tertiary text-sm">
              {statusFilter ? "No videos with this status" : "You have no videos yet"}
            </p>
            {!statusFilter && (
              <Link href="/create">
                <Button variant="primary" size="sm">Create your first video</Button>
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {videos.map((v) => (
                <VideoCard
                  key={v.id}
                  id={v.id}
                  title={v.title}
                  status={v.status}
                  duration={v.durationSec ?? undefined}
                  createdAt={v.createdAt}
                  onClick={() => router.push(`/videos/${v.id}`)}
                />
              ))}
            </div>

            {/* Pagination */}
            {pagination && pagination.pages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-4">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  ←
                </Button>
                <span className="text-xs text-text-secondary tabular-nums">
                  {page} / {pagination.pages}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page >= pagination.pages}
                  onClick={() => goToPage(page + 1)}
                >
                  →
                </Button>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

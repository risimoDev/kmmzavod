"use client";

import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  LoadingSpinner,
  Badge,
  Card,
  CardContent,
  Input,
  Progress,
  EmptyState,
} from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime } from "@/lib/utils";
import {
  uniquifyApi,
  getAccessToken,
  socialAccountsApi,
  type SourceVideo,
  type UniquifyJob,
  type Pagination,
  type SocialAccount,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const TABS = [
  { value: "sources", label: "Source Videos" },
  { value: "jobs", label: "Jobs" },
];

const JOB_STATUSES = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "analyzing", label: "Analyzing" },
  { value: "generating", label: "Generating" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

export default function UniquifyPage() {
  return (
    <Suspense
      fallback={
        <>
          <TopBar title="Uniquify" />
          <main className="flex-1 flex items-center justify-center">
            <LoadingSpinner size={32} />
          </main>
        </>
      }
    >
      <UniquifyContent />
    </Suspense>
  );
}

function UniquifyContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") ?? "sources";

  const [sources, setSources] = useState<SourceVideo[]>([]);
  const [sourcePagination, setSourcePagination] = useState<Pagination | null>(null);

  const [jobs, setJobs] = useState<UniquifyJob[]>([]);
  const [jobPagination, setJobPagination] = useState<Pagination | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const statusFilter = searchParams.get("status") ?? "";
  const page = Number(searchParams.get("page") ?? "1");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === "sources") {
        const res = await uniquifyApi.listSourceVideos({ page, limit: 18 });
        setSources(res.items);
        setSourcePagination(res.pagination);
      } else {
        const res = await uniquifyApi.listJobs({
          status: statusFilter || undefined,
          page,
          limit: 18,
        });
        setJobs(res.items);
        setJobPagination(res.pagination);
      }
    } catch (e: any) {
      setError(e.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [tab, statusFilter, page]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace("/login");
      return;
    }
    load();
  }, [load, router]);

  const setTab = (t: string) => {
    router.push(`/uniquify?tab=${t}`);
  };

  const setFilter = (status: string) => {
    const params = new URLSearchParams();
    params.set("tab", tab);
    if (status) params.set("status", status);
    router.push(`/uniquify?${params}`);
  };

  const goToPage = (p: number) => {
    const params = new URLSearchParams();
    params.set("tab", tab);
    if (statusFilter) params.set("status", statusFilter);
    if (p > 1) params.set("page", String(p));
    router.push(`/uniquify?${params}`);
  };

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith("video/")) {
      alert("Please select a video file");
      return;
    }
    setUploading(true);
    try {
      const { uploadUrl, sourceVideoId } = await uniquifyApi.uploadUrl({
        title: file.name,
      });

      // Upload directly to MinIO
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!uploadRes.ok) throw new Error("Upload failed");

      // Confirm
      await uniquifyApi.confirmUpload(sourceVideoId);

      // Refresh
      load();
    } catch (e: any) {
      alert(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleCreateJob = async (sourceVideoId: string) => {
    try {
      await uniquifyApi.createJob({
        sourceVideoId,
        variantCount: 5,
      });
      setTab("jobs");
    } catch (e: any) {
      alert(e.message ?? "Failed to create job");
    }
  };

  return (
    <>
      <TopBar
        title="Uniquify"
        subtitle="Upload source videos and generate unique variants"
        actions={
          tab === "sources" && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFileSelect(f);
                }}
              />
              <Button
                variant="primary"
                size="sm"
                loading={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon /> Upload Video
              </Button>
            </>
          )
        }
      />

      <main className="flex-1 p-6 space-y-5 animate-slide-up">
        {/* Tabs */}
        <div className="flex gap-2">
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                tab === t.value
                  ? "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30"
                  : "bg-surface-2 text-text-secondary hover:text-text-primary hover:bg-surface-3"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "jobs" && (
          <div className="flex gap-2 flex-wrap">
            {JOB_STATUSES.map((s) => (
              <button
                key={s.value}
                onClick={() => setFilter(s.value)}
                className={cn(
                  "px-3 py-1 rounded-lg text-xs font-medium transition-all",
                  statusFilter === s.value
                    ? "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30"
                    : "bg-surface-2 text-text-secondary hover:text-text-primary hover:bg-surface-3"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

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
        ) : tab === "sources" ? (
          sources.length === 0 ? (
            <EmptyState
              title="No source videos"
              description="Upload a video to start uniquification"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <UploadIcon /> Upload Video
                </Button>
              }
            />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {sources.map((sv) => (
                  <SourceVideoCard
                    key={sv.id}
                    source={sv}
                    onCreateJob={() => handleCreateJob(sv.id)}
                  />
                ))}
              </div>
              {sourcePagination && sourcePagination.pages > 1 && (
                <PaginationControls
                  page={page}
                  pages={sourcePagination.pages}
                  onChange={goToPage}
                />
              )}
            </>
          )
        ) : jobs.length === 0 ? (
          <EmptyState
            title="No uniquify jobs"
            description="Upload a source video and create a job"
            action={
              <Button variant="primary" size="sm" onClick={() => setTab("sources")}>
                Go to Sources
              </Button>
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {jobs.map((job) => (
                <JobCard key={job.id} job={job} onClick={() => router.push(`/uniquify/jobs/${job.id}`)} />
              ))}
            </div>
            {jobPagination && jobPagination.pages > 1 && (
              <PaginationControls
                page={page}
                pages={jobPagination.pages}
                onChange={goToPage}
              />
            )}
          </>
        )}
      </main>
    </>
  );
}

function SourceVideoCard({
  source,
  onCreateJob,
}: {
  source: SourceVideo;
  onCreateJob: () => void;
}) {
  return (
    <Card className="flex flex-col">
      <CardContent className="flex-1 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">{source.title}</p>
            <p className="text-xs text-text-tertiary mt-0.5">
              {source.width && source.height
                ? `${source.width}×${source.height}`
                : "Analyzing..."}
              {source.durationSec ? ` · ${Math.round(source.durationSec)}s` : ""}
            </p>
          </div>
          <StatusBadge status={source.status} />
        </div>

        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          <span>{source.fileSizeMb ? `${source.fileSizeMb.toFixed(1)} MB` : "—"}</span>
          <span>·</span>
          <span>{relativeTime(source.createdAt)}</span>
        </div>
      </CardContent>
      <div className="px-5 py-3 border-t border-border flex gap-2">
        <Button
          variant="primary"
          size="sm"
          className="flex-1"
          disabled={source.status !== "ready"}
          onClick={(e) => {
            e.stopPropagation();
            onCreateJob();
          }}
        >
          <SparklesIcon /> Create Job
        </Button>
      </div>
    </Card>
  );
}

function JobCard({ job, onClick }: { job: UniquifyJob; onClick: () => void }) {
  const progress =
    job.variantCount > 0
      ? Math.round(((job.completedCount + job.failedCount) / job.variantCount) * 100)
      : 0;

  return (
    <Card hoverable onClick={onClick}>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">
              Job {job.id.slice(0, 8)}
            </p>
            <p className="text-xs text-text-tertiary mt-0.5">
              {job.variantCount} variants · {job.creditsUsed} credits
            </p>
          </div>
          <StatusBadge status={job.status} />
        </div>

        <div className="space-y-1">
          <Progress value={progress} max={100} size="sm" showLabel />
          <p className="text-xs text-text-tertiary">
            {job.completedCount} done · {job.failedCount} failed ·{" "}
            {job.variantCount - job.completedCount - job.failedCount} pending
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          <span>{relativeTime(job.createdAt)}</span>
          {job.error && (
            <Badge variant="danger" className="truncate max-w-[200px]">
              {job.error}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PaginationControls({
  page,
  pages,
  onChange,
}: {
  page: number;
  pages: number;
  onChange: (p: number) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2 pt-4">
      <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        ←
      </Button>
      <span className="text-xs text-text-secondary tabular-nums">
        {page} / {pages}
      </span>
      <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        →
      </Button>
    </div>
  );
}

function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v18M3 12h18"/>
      <circle cx="12" cy="12" r="9" strokeDasharray="4 4"/>
    </svg>
  );
}

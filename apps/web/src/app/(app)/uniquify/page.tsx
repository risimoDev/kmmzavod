"use client";

import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  LoadingSpinner,
  Badge,
  Card,
  CardContent,
  Input,
  Textarea,
  Progress,
  EmptyState,
} from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime } from "@/lib/utils";
import {
  uniquifyApi,
  getAccessToken,
  type SourceVideo,
  type UniquifyJob,
  type Pagination,
  type BgmTrack,
  type TtsVoice,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const TABS = [
  { value: "sources", label: "Source Videos" },
  { value: "jobs", label: "Jobs" },
  { value: "music", label: "Music" },
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

  const [tracks, setTracks] = useState<BgmTrack[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const [createFor, setCreateFor] = useState<SourceVideo | null>(null);

  const statusFilter = searchParams.get("status") ?? "";
  const page = Number(searchParams.get("page") ?? "1");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      if (tab === "sources") {
        const res = await uniquifyApi.listSourceVideos({ page, limit: 18 });
        setSources(res.items);
        setSourcePagination(res.pagination);
      } else if (tab === "music") {
        const res = await uniquifyApi.listBgm();
        setTracks(res.items);
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
      if (!silent) setError(e.message ?? "Failed to load");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [tab, statusFilter, page]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace("/login");
      return;
    }
    load();
  }, [load, router]);

  // Live updates: silently re-poll while there is active work (no page reload).
  const SOURCE_BUSY = ["uploading", "analyzing"];
  const JOB_BUSY = ["pending", "analyzing", "generating"];
  const hasActiveWork =
    (tab === "sources" && sources.some((s) => SOURCE_BUSY.includes(s.status))) ||
    (tab === "jobs" && jobs.some((j) => JOB_BUSY.includes(j.status)));

  useEffect(() => {
    if (!hasActiveWork) return;
    const id = setInterval(() => load(true), 4000);
    return () => clearInterval(id);
  }, [hasActiveWork, load]);

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
      await uniquifyApi.upload(file, { title: file.name });
      load();
    } catch (e: any) {
      alert(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleAudioSelect = async (file: File) => {
    const isAudio = file.type.startsWith("audio/") || /\.(mp3|wav|aac|m4a|ogg|flac)$/i.test(file.name);
    if (!isAudio) {
      alert("Please select an audio file");
      return;
    }
    setUploading(true);
    try {
      await uniquifyApi.uploadBgm(file);
      load();
    } catch (e: any) {
      alert(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
      if (audioInputRef.current) audioInputRef.current.value = "";
    }
  };

  const handleDeleteTrack = async (key: string) => {
    if (!confirm("Удалить трек из библиотеки?")) return;
    try {
      await uniquifyApi.deleteBgm(key);
      setTracks((prev) => prev.filter((t) => t.key !== key));
    } catch (e: any) {
      alert(e.message ?? "Failed to delete");
    }
  };

  return (
    <>
      <TopBar
        title="Uniquify"
        subtitle="Upload source videos and generate unique variants"
        actions={
          <>
            {tab === "sources" && (
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
            )}
            {tab === "music" && (
              <>
                <input
                  ref={audioInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleAudioSelect(f);
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={uploading}
                  onClick={() => audioInputRef.current?.click()}
                >
                  <UploadIcon /> Upload Track
                </Button>
              </>
            )}
          </>
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
            <Button variant="outline" size="sm" onClick={() => load()}>
              Retry
            </Button>
          </div>
        ) : tab === "music" ? (
          <MusicLibrary
            tracks={tracks}
            onDelete={handleDeleteTrack}
            onUpload={() => audioInputRef.current?.click()}
          />
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
                    onCreateJob={() => setCreateFor(sv)}
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

      {createFor && (
        <CreateJobModal
          source={createFor}
          onClose={() => setCreateFor(null)}
          onCreated={() => {
            setCreateFor(null);
            setTab("jobs");
          }}
        />
      )}
    </>
  );
}

// ── Create Job modal ──────────────────────────────────────────────────────────

const ASPECTS = [
  { value: "9:16", label: "9:16 (TikTok/Reels/Shorts)" },
  { value: "1:1", label: "1:1 (квадрат)" },
  { value: "4:5", label: "4:5 (лента)" },
  { value: "16:9", label: "16:9 (YouTube)" },
];

function CreateJobModal({
  source,
  onClose,
  onCreated,
}: {
  source: SourceVideo;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [variantCount, setVariantCount] = useState(10);
  const [aspectRatio, setAspectRatio] = useState<"9:16" | "1:1" | "16:9" | "4:5">("9:16");
  const [language, setLanguage] = useState("ru");
  const [voiceId, setVoiceId] = useState("");
  const [targetSeconds, setTargetSeconds] = useState(30);
  const [productInfo, setProductInfo] = useState("");
  const [enableSubtitles, setEnableSubtitles] = useState(true);
  const [enableBgm, setEnableBgm] = useState(true);
  const [beatSync, setBeatSync] = useState(true);

  const [tracks, setTracks] = useState<BgmTrack[]>([]);
  const [selectedTracks, setSelectedTracks] = useState<string[]>([]);
  const [loadingTracks, setLoadingTracks] = useState(true);

  const [voices, setVoices] = useState<TtsVoice[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    uniquifyApi
      .listBgm()
      .then((res) => {
        setTracks(res.items);
        setSelectedTracks(res.items.map((t) => t.key)); // default: use all
      })
      .catch(() => setTracks([]))
      .finally(() => setLoadingTracks(false));
    uniquifyApi
      .listVoices()
      .then((res) => setVoices(res.items))
      .catch(() => setVoices([]));
  }, []);

  const toggleTrack = (key: string) => {
    setSelectedTracks((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      await uniquifyApi.createJob({
        sourceVideoId: source.id,
        variantCount,
        config: {
          aspectRatio,
          language,
          voiceId: voiceId.trim() || undefined,
          targetSeconds,
          productInfo: productInfo.trim() || undefined,
          enableSubtitles,
          enableBgm,
          beatSync,
          bgmTrackKeys: enableBgm ? selectedTracks : [],
        },
      });
      onCreated();
    } catch (e: any) {
      setErr(e.message ?? "Не удалось создать задачу");
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-surface-1 ring-1 ring-border p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Создать задачу уникализации</h2>
          <p className="text-xs text-text-tertiary mt-0.5 truncate">{source.title}</p>
        </div>

        <Field label="Что за товар (для точной озвучки)">
          <Textarea
            value={productInfo}
            onChange={(e) => setProductInfo(e.target.value)}
            placeholder="Опишите товар: что это, для кого, ключевые преимущества, цена/акция — нейросеть напишет сценарий точнее"
            rows={3}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Кол-во вариантов">
            <Input
              type="number"
              min={1}
              max={100}
              value={variantCount}
              onChange={(e) => setVariantCount(Math.max(1, Math.min(100, +e.target.value || 1)))}
            />
          </Field>
          <Field label="Длительность, сек">
            <Input
              type="number"
              min={8}
              max={120}
              value={targetSeconds}
              onChange={(e) => setTargetSeconds(Math.max(8, Math.min(120, +e.target.value || 30)))}
            />
          </Field>
          <Field label="Формат">
            <select
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value as any)}
              className="w-full h-9 rounded-lg bg-surface-2 ring-1 ring-border px-2 text-xs text-text-primary"
            >
              {ASPECTS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Язык (ISO)">
            <Input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="ru" />
          </Field>
        </div>

        <Field label="Голос озвучки">
          <select
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            className="w-full h-9 rounded-lg bg-surface-2 ring-1 ring-border px-2 text-xs text-text-primary"
          >
            <option value="">По умолчанию (ALEX)</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="space-y-2">
          <Checkbox checked={enableSubtitles} onChange={setEnableSubtitles} label="Субтитры (по озвучке)" />
          <Checkbox checked={beatSync} onChange={setBeatSync} label="Нарезка под ритм музыки" />
          <Checkbox checked={enableBgm} onChange={setEnableBgm} label="Фоновая музыка (разная на вариант)" />
        </div>

        {enableBgm && (
          <div className="rounded-lg bg-surface-2 ring-1 ring-border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">
                Треки для ротации ({selectedTracks.length})
              </span>
            </div>
            {loadingTracks ? (
              <LoadingSpinner size={16} />
            ) : tracks.length === 0 ? (
              <p className="text-xs text-text-tertiary">
                Библиотека пуста — загрузите треки на вкладке «Music». Без музыки аудио будет
                одинаковым во всех вариантах.
              </p>
            ) : (
              <div className="max-h-32 overflow-y-auto space-y-1">
                {tracks.map((t) => (
                  <label key={t.key} className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedTracks.includes(t.key)}
                      onChange={() => toggleTrack(t.key)}
                      className="rounded"
                    />
                    <span className="truncate">{t.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {err && <p className="text-xs text-rose-400">{err}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Отмена
          </Button>
          <Button variant="primary" size="sm" loading={submitting} onClick={submit}>
            Создать
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="rounded" />
      <span>{label}</span>
    </label>
  );
}

// ── Music library ───────────────────────────────────────────────────────────

function MusicLibrary({
  tracks,
  onDelete,
  onUpload,
}: {
  tracks: BgmTrack[];
  onDelete: (key: string) => void;
  onUpload: () => void;
}) {
  if (tracks.length === 0) {
    return (
      <EmptyState
        title="Библиотека музыки пуста"
        description="Загрузите royalty-free треки — каждый вариант получит свой, чтобы аудио-фингерпринт отличался"
        action={
          <Button variant="primary" size="sm" onClick={onUpload}>
            <UploadIcon /> Upload Track
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-tertiary">
        {tracks.length} треков · используются в монтаже по очереди (разный трек на каждый вариант)
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {tracks.map((t) => (
          <Card key={t.key}>
            <CardContent className="flex items-center gap-3">
              <div className="shrink-0 w-9 h-9 rounded-lg bg-brand-500/15 text-brand-400 flex items-center justify-center">
                <MusicIcon />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary truncate">{t.name}</p>
                {t.url && (
                  <audio controls src={t.url} className="mt-1 w-full h-8" preload="none" />
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => onDelete(t.key)}>
                <TrashIcon />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
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

function MusicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
    </svg>
  );
}

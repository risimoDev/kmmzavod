"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  CardContent,
  LoadingSpinner,
  Skeleton,
  Badge,
} from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDuration, relativeTime } from "@/lib/utils";
import {
  videosApi,
  socialAccountsApi,
  getAccessToken,
  type VideoDetail,
  type VideoVariant,
  type SocialAccount,
  type PublishJob,
} from "@/lib/api";
import { useVideoProgress } from "@/hooks/useVideoProgress";

/* ── Stage labels ──────────────────────────────────────────────────────────── */

const STAGE_META: Record<string, { label: string; icon: string }> = {
  pipeline:          { label: "Запуск",               icon: "🚀" },
  "gpt-script":     { label: "Генерация сценария",   icon: "📝" },
  "heygen-render":  { label: "Рендер аватара",       icon: "🎭" },
  "runway-clip":    { label: "Генерация B-roll",     icon: "🎬" },
  "image-gen":      { label: "Генерация изображений", icon: "🖼️" },
  "kling-clip":     { label: "Генерация клипа",      icon: "🎞️" },
  processing:       { label: "Обработка сцен",       icon: "⚙️" },
  composing:        { label: "Композиция видео",     icon: "🔧" },
  "video-compose":  { label: "Финализация",          icon: "🎥" },
  "pipeline-state": { label: "Проверка готовности",  icon: "✅" },
  completed:        { label: "Готово",               icon: "✅" },
  failed:           { label: "Ошибка",               icon: "❌" },
};

const PRESET_META: Record<string, { title: string; desc: string }> = {
  dynamic: { title: "Dynamic", desc: "Энергичный монтаж с быстрыми переходами" },
  smooth:  { title: "Smooth",  desc: "Плавные переходы и мягкие эффекты" },
  minimal: { title: "Minimal", desc: "Минималистичный стиль без спецэффектов" },
};

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube_shorts: "YouTube Shorts",
};

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);

  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);

  const isProcessing =
    video != null && ["pending", "processing", "composing"].includes(video.status);
  const sse = useVideoProgress(id, isProcessing);

  /* ── Data loading ────────────────────────────────────────────────────────── */

  const loadVideo = useCallback(() => {
    videosApi
      .get(id)
      .then(setVideo)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace("/login");
      return;
    }
    loadVideo();
  }, [id, router, loadVideo]);

  // Reload on SSE terminal state
  useEffect(() => {
    if (sse.isComplete || sse.isFailed) {
      const timer = setTimeout(loadVideo, 1500);
      return () => clearTimeout(timer);
    }
  }, [sse.isComplete, sse.isFailed, loadVideo]);

  // Load social accounts when a variant is selected
  const selectedVariant = video?.variants?.find((v) => v.selectedAt);
  useEffect(() => {
    if (selectedVariant) {
      setAccountsLoading(true);
      socialAccountsApi
        .list()
        .then(setAccounts)
        .catch(() => {})
        .finally(() => setAccountsLoading(false));
    }
  }, [selectedVariant?.id]);

  /* ── Handlers ────────────────────────────────────────────────────────────── */

  const handleSelectVariant = async (variantId: string) => {
    setSelectingId(variantId);
    try {
      await videosApi.selectVariant(id, variantId);
      loadVideo();
    } catch {}
    setSelectingId(null);
  };

  const handlePublish = async (account: SocialAccount) => {
    if (!selectedVariant) return;
    setPublishingId(account.id);
    try {
      await videosApi.publish(id, {
        socialAccountId: account.id,
        platform: account.platform,
      });
      loadVideo();
    } catch {}
    setPublishingId(null);
  };

  /* ── Skeleton loader ─────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <>
        <TopBar title="Видео" />
        <main className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="py-3 px-4 space-y-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-6 w-24" />
                </CardContent>
              </Card>
            ))}
          </div>
          <Skeleton className="h-20 w-full rounded-xl" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-48 rounded-xl" />
            ))}
          </div>
        </main>
      </>
    );
  }

  if (error || !video) {
    return (
      <>
        <TopBar title="Видео" />
        <main className="flex-1 flex flex-col items-center justify-center gap-4">
          <p className="text-text-secondary text-sm">{error ?? "Видео не найдено"}</p>
          <Button variant="outline" size="sm" onClick={() => router.back()}>
            Назад
          </Button>
        </main>
      </>
    );
  }

  /* ── Computed data ───────────────────────────────────────────────────────── */

  const scenes = video.job?.scenes ?? [];
  const dbEvents = video.job?.events ?? [];

  const done = scenes.filter((s) => s.status === "completed").length;
  const staticPct = scenes.length > 0 ? Math.round((done / scenes.length) * 100) : 0;
  const livePct = isProcessing && sse.progress > 0 ? sse.progress : staticPct;
  const pct = video.status === "completed" ? 100 : livePct;

  const allEvents = [
    ...dbEvents.map((e) => ({
      key: `db-${e.id}`,
      time: new Date(e.createdAt).toLocaleTimeString("ru-RU"),
      stage: e.stage,
      status: e.status,
      message: e.message,
    })),
    ...sse.events.map((e, i) => ({
      key: `sse-${i}`,
      time: new Date(e.timestamp).toLocaleTimeString("ru-RU"),
      stage: e.stage,
      status: e.status,
      message: e.message,
    })),
  ].slice(-10);

  const isCompleted = video.status === "completed";
  const readyVariants = video.variants?.filter((v) => v.status === "ready") ?? [];
  const publishJobs = video.publishJobs ?? [];

  /* ── Render ──────────────────────────────────────────────────────────────── */

  return (
    <>
      <TopBar
        title={video.title}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={video.status as any} />
            <Button variant="outline" size="sm" onClick={() => router.back()}>
              Назад
            </Button>
          </div>
        }
      />

      <main className="flex-1 overflow-y-auto p-6 space-y-6 animate-slide-up">
        {/* ── Stats grid ──────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="py-3 px-4">
              <p className="text-xs text-text-tertiary">Статус</p>
              <StatusBadge status={video.status as any} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 px-4">
              <p className="text-xs text-text-tertiary">Длительность</p>
              <p className="text-lg font-bold text-text-primary">
                {video.durationSec ? formatDuration(video.durationSec) : "\u2014"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 px-4">
              <p className="text-xs text-text-tertiary">Кредиты</p>
              <p className="text-lg font-bold text-text-primary">{video.creditsUsed}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 px-4">
              <p className="text-xs text-text-tertiary">Создано</p>
              <p className="text-sm font-medium text-text-primary">
                {relativeTime(video.createdAt)}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* ── Error section (visible when failed) ─────────────────────────── */}
        {video.status === "failed" && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-5 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-red-400 text-lg">❌</span>
              <p className="text-sm font-semibold text-red-400">
                Ошибка генерации видео
              </p>
            </div>
            {(video.error || video.job?.error) && (
              <p className="text-sm text-text-secondary bg-surface-2 rounded-lg p-3 font-mono break-all">
                {video.error || video.job?.error}
              </p>
            )}
            {/* Show failed scenes with their errors */}
            {scenes.filter((s) => s.status === "failed" && s.error).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
                  Ошибки по сценам
                </p>
                {scenes
                  .filter((s) => s.status === "failed" && s.error)
                  .map((s) => (
                    <div
                      key={s.id}
                      className="flex items-start gap-3 text-xs bg-surface-2 rounded-lg p-3"
                    >
                      <span className="text-red-400 font-medium whitespace-nowrap">
                        Сцена {s.sceneIndex + 1} ({s.type})
                      </span>
                      <span className="text-text-secondary font-mono break-all">
                        {s.error}
                      </span>
                    </div>
                  ))}
              </div>
            )}
            {/* Show failed events */}
            {dbEvents.filter((e) => e.status === "failed").length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
                  Журнал ошибок
                </p>
                {dbEvents
                  .filter((e) => e.status === "failed")
                  .map((e) => (
                    <div
                      key={e.id}
                      className="flex items-start gap-3 text-xs bg-surface-2 rounded-lg p-3"
                    >
                      <span className="text-text-tertiary whitespace-nowrap">
                        {new Date(e.createdAt).toLocaleTimeString("ru-RU")}
                      </span>
                      <span className="text-red-400 font-medium">
                        {STAGE_META[e.stage]?.label ?? e.stage}
                      </span>
                      {e.message && (
                        <span className="text-text-secondary font-mono break-all">
                          {e.message}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* ── Progress section (hidden when completed) ────────────────────── */}
        {!isCompleted && (isProcessing || scenes.length > 0) && (
          <div className="rounded-xl border border-border bg-surface-1 p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-semibold text-text-primary">Прогресс</p>
                {isProcessing && sse.stage && (
                  <p className="text-xs text-text-tertiary mt-0.5">
                    <span className="mr-1">
                      {STAGE_META[sse.stage]?.icon ?? "⏳"}
                    </span>
                    {STAGE_META[sse.stage]?.label ?? sse.stage}
                    {sse.message ? ` — ${sse.message}` : ""}
                  </p>
                )}
              </div>
              <span className="text-xs font-medium text-text-tertiary">{pct}%</span>
            </div>
            <div className="relative h-2.5 rounded-full bg-surface-2 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-brand transition-all duration-700 ease-out"
                style={{ width: `${pct}%` }}
              />
              {isProcessing && pct < 100 && (
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-brand/30 animate-pulse"
                  style={{ width: `${Math.min(pct + 5, 100)}%` }}
                />
              )}
            </div>

            {/* Event log (last 10) */}
            {allEvents.length > 0 && (
              <div className="mt-4 space-y-1.5 max-h-52 overflow-y-auto">
                {allEvents.map((e) => (
                  <div key={e.key} className="flex items-start gap-3 text-xs">
                    <span className="text-text-tertiary whitespace-nowrap">{e.time}</span>
                    <span className="mr-0.5">
                      {STAGE_META[e.stage]?.icon ?? "⏳"}
                    </span>
                    <span className="text-text-secondary">
                      <span className="font-medium text-text-primary">
                        {STAGE_META[e.stage]?.label ?? e.stage}
                      </span>
                      {e.message && ` — ${e.message}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Variant selection (visible when completed) ──────────────────── */}
        {isCompleted && readyVariants.length > 0 && (
          <div>
            <p className="text-sm font-semibold text-text-primary mb-3">
              Выберите вариант монтажа
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {readyVariants.map((v) => {
                const meta = PRESET_META[v.preset] ?? {
                  title: v.preset,
                  desc: "",
                };
                const isSelected = v.selectedAt != null;
                return (
                  <Card
                    key={v.id}
                    className={`relative transition-all ${
                      isSelected
                        ? "ring-2 ring-brand border-brand"
                        : "hover:border-text-tertiary"
                    }`}
                  >
                    {isSelected && (
                      <div className="absolute top-3 right-3 w-6 h-6 rounded-full bg-brand flex items-center justify-center">
                        <svg
                          className="w-3.5 h-3.5 text-white"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={3}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      </div>
                    )}
                    <CardContent className="py-4 px-4 space-y-3">
                      <div>
                        <p className="text-base font-semibold text-text-primary">
                          {meta.title}
                        </p>
                        <p className="text-xs text-text-tertiary mt-0.5">
                          {meta.desc}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-secondary">
                        {v.durationSec != null && (
                          <span>{formatDuration(v.durationSec)}</span>
                        )}
                        {v.fileSizeMb != null && (
                          <span>{v.fileSizeMb} МБ</span>
                        )}
                      </div>
                      {!isSelected && (
                        <Button
                          size="sm"
                          variant="primary"
                          className="w-full"
                          loading={selectingId === v.id}
                          onClick={() => handleSelectVariant(v.id)}
                        >
                          Выбрать
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Video player (after variant selected) ───────────────────────── */}
        {selectedVariant?.outputUrl && (
          <div className="rounded-xl border border-border bg-surface-1 overflow-hidden">
            <video
              controls
              className="w-full max-h-[480px] bg-black"
              src={selectedVariant.outputUrl}
            />
          </div>
        )}

        {/* ── Publish section (after variant selected) ────────────────────── */}
        {selectedVariant && (
          <div>
            <p className="text-sm font-semibold text-text-primary mb-3">
              Публикация
            </p>

            {accountsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 rounded-xl" />
                ))}
              </div>
            ) : accounts.length === 0 ? (
              <Card>
                <CardContent className="py-6 text-center">
                  <p className="text-text-tertiary text-sm">
                    Нет подключённых аккаунтов
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {accounts
                  .filter((a) => a.isActive)
                  .map((account) => {
                    const job = publishJobs.find(
                      (j) => j.socialAccountId === account.id,
                    );
                    return (
                      <Card key={account.id}>
                        <CardContent className="py-3 px-4 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-medium text-text-primary">
                              {PLATFORM_LABELS[account.platform] ??
                                account.platform}
                            </span>
                            <span className="text-xs text-text-tertiary">
                              {account.accountName}
                            </span>
                            {job && (
                              <PublishStatusBadge
                                status={job.status}
                                error={job.error}
                              />
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {(!job ||
                              job.status === "failed") && (
                              <Button
                                size="sm"
                                variant="primary"
                                loading={publishingId === account.id}
                                onClick={() => handlePublish(account)}
                              >
                                Опубликовать
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
              </div>
            )}
          </div>
        )}

        {/* ── Scene table ─────────────────────────────────────────────────── */}
        {scenes.length > 0 && (
          <div>
            <p className="text-sm font-semibold text-text-primary mb-3">Сцены</p>
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-1 text-text-tertiary text-xs uppercase tracking-wider">
                    <th className="text-left py-2.5 px-4 font-medium">#</th>
                    <th className="text-left py-2.5 px-4 font-medium">Тип</th>
                    <th className="text-left py-2.5 px-4 font-medium">Статус</th>
                    <th className="text-left py-2.5 px-4 font-medium">Длит.</th>
                    <th className="text-left py-2.5 px-4 font-medium">Ошибка</th>
                  </tr>
                </thead>
                <tbody>
                  {scenes.map((s) => (
                    <tr key={s.id} className="border-t border-border">
                      <td className="py-2.5 px-4 text-text-primary font-medium">
                        {s.sceneIndex + 1}
                      </td>
                      <td className="py-2.5 px-4 text-text-secondary">{s.type}</td>
                      <td className="py-2.5 px-4">
                        <StatusBadge status={s.status as any} />
                      </td>
                      <td className="py-2.5 px-4 text-text-secondary">
                        {s.durationSec ? `${s.durationSec}с` : "\u2014"}
                      </td>
                      <td className="py-2.5 px-4 text-red-400 text-xs max-w-xs truncate" title={s.error ?? undefined}>
                        {s.error ?? "\u2014"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

/* ── Publish status badge ──────────────────────────────────────────────────── */

function PublishStatusBadge({
  status,
  error,
}: {
  status: string;
  error: string | null;
}) {
  const map: Record<string, { label: string; variant: "default" | "success" | "warning" | "danger" | "info" }> = {
    pending:   { label: "Ожидание",     variant: "default" },
    scheduled: { label: "Запланировано", variant: "info" },
    uploading: { label: "Загрузка",     variant: "warning" },
    published: { label: "Опубликовано", variant: "success" },
    failed:    { label: "Ошибка",       variant: "danger" },
  };
  const m = map[status] ?? { label: status, variant: "default" as const };
  return (
    <span title={error ?? undefined}>
      <Badge variant={m.variant} dot>
        {m.label}
      </Badge>
    </span>
  );
}
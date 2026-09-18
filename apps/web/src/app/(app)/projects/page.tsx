"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  CardContent,
  Input,
  Badge,
  LoadingSpinner,
  EmptyState,
  Progress,
} from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime, formatDuration, cn } from "@/lib/utils";
import {
  projectsApi,
  getAccessToken,
  type Project,
  type ProjectHubDetail,
  type SourceVideo,
  type EditClip,
  type UniqueVariant,
  type DistributeJob,
} from "@/lib/api";

const COLORS = ["#7C3AED", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#EC4899", "#8B5CF6", "#06B6D4"];

type HubTab = "raw" | "master" | "uniquified" | "distributions";

export default function ProjectsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<HubTab>("raw");
  const [loading, setLoading] = useState(true);
  const [hubLoading, setHubLoading] = useState(false);
  const [hub, setHub] = useState<ProjectHubDetail | null>(null);

  // Search & Project creation modal
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Selection state for raw videos
  const [selectedRawVideoIds, setSelectedRawVideoIds] = useState<string[]>([]);

  // Load project list on mount
  useEffect(() => {
    if (!getAccessToken()) {
      router.replace("/login");
      return;
    }
    projectsApi
      .list()
      .then((data) => {
        setProjects(data);
        const querySelected = searchParams.get("selected");
        if (querySelected && data.some((p) => p.id === querySelected)) {
          setSelectedId(querySelected);
        } else if (data.length > 0) {
          setSelectedId(data[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [router, searchParams]);

  // Load hub details when selected project changes
  const loadHub = useCallback(
    async (id: string, silent = false) => {
      if (!silent) setHubLoading(true);
      try {
        const data = await projectsApi.hub(id);
        setHub(data);
      } catch {
        // ignore
      } finally {
        if (!silent) setHubLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (selectedId) {
      loadHub(selectedId);
      setSelectedRawVideoIds([]);
    } else {
      setHub(null);
    }
  }, [selectedId, loadHub]);

  // Create project handler
  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const p = await projectsApi.create({ name: newName, description: newDesc || undefined });
      setProjects((prev) => [p, ...prev]);
      setSelectedId(p.id);
      setNewName("");
      setNewDesc("");
      setCreateOpen(false);
    } catch {}
    setCreating(false);
  };

  // Upload raw video files handler
  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0 || !selectedId) return;
    setUploading(true);
    setUploadProgress(10);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress(Math.round(((i + 0.3) / files.length) * 100));
        await projectsApi.uploadSourceVideo(selectedId, file);
        setUploadProgress(Math.round(((i + 1) / files.length) * 100));
      }
      await loadHub(selectedId, true);
    } catch (err: any) {
      alert(err.message ?? "Ошибка загрузки видео");
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Toggle raw video selection
  const toggleRawSelect = (id: string) => {
    setSelectedRawVideoIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const selectAllRaw = () => {
    if (!hub) return;
    if (selectedRawVideoIds.length === hub.rawVideos.length) {
      setSelectedRawVideoIds([]);
    } else {
      setSelectedRawVideoIds(hub.rawVideos.map((v) => v.id));
    }
  };

  // Delete raw video handler
  const handleDeleteRawVideo = async (videoId: string) => {
    if (!selectedId || !confirm("Удалить это видео из проекта?")) return;
    try {
      await projectsApi.deleteSourceVideo(selectedId, videoId);
      setHub((prev) =>
        prev ? { ...prev, rawVideos: prev.rawVideos.filter((v) => v.id !== videoId) } : null,
      );
      setSelectedRawVideoIds((prev) => prev.filter((id) => id !== videoId));
    } catch (e: any) {
      alert(e.message ?? "Ошибка при удалении");
    }
  };

  // Navigate to Smart Editor with selected video(s)
  const handleOpenInEditor = () => {
    if (!selectedId) return;
    const sourceIdsQuery = selectedRawVideoIds.length > 0 ? `&sources=${selectedRawVideoIds.join(",")}` : "";
    router.push(`/editor?projectId=${selectedId}${sourceIdsQuery}`);
  };

  // Navigate to Uniquifier with a chosen video
  const handleOpenInUniquify = (sourceVideoId: string) => {
    if (!selectedId) return;
    router.push(`/uniquify?sourceVideoId=${sourceVideoId}&projectId=${selectedId}`);
  };

  // Navigate to Distribution Matrix with a completed uniquify job
  const handleOpenDistribution = (uniquifyJobId: string) => {
    router.push(`/uniquify/jobs/${uniquifyJobId}`);
  };

  const filteredProjects = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.description ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  if (loading) {
    return (
      <>
        <TopBar title="Проекты" />
        <main className="flex-1 flex items-center justify-center">
          <LoadingSpinner size={32} />
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar
        title="Проекты"
        subtitle="Сквозной конвейер: Сырьё → Умный монтаж → Уникализация → Автопубликация"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            + Новый проект
          </Button>
        }
      />

      <main className="flex-1 flex flex-col lg:flex-row lg:h-[calc(100vh-56px)] overflow-hidden">
        {/* Left Sidebar: Project List */}
        <aside className="w-full lg:w-72 flex-shrink-0 border-r border-border flex flex-col bg-surface-0">
          <div className="p-3 border-b border-border">
            <Input
              placeholder="Поиск проектов…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <ul className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredProjects.map((p, i) => (
              <li key={p.id}>
                <button
                  onClick={() => setSelectedId(p.id)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-lg transition-all",
                    selectedId === p.id
                      ? "bg-brand-500/10 border border-brand-500/30 text-brand-400"
                      : "hover:bg-surface-2 border border-transparent text-text-primary",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: COLORS[i % COLORS.length] }}
                    />
                    <span className="text-sm font-semibold truncate flex-1">{p.name}</span>
                  </div>
                  {p.description && (
                    <p className="text-2xs text-text-tertiary truncate pl-5 mt-0.5">
                      {p.description}
                    </p>
                  )}
                  <div className="flex items-center justify-between mt-1.5 pl-5 text-3xs text-text-tertiary">
                    <span>{relativeTime(p.createdAt)}</span>
                  </div>
                </button>
              </li>
            ))}
            {filteredProjects.length === 0 && (
              <li className="text-center text-text-tertiary text-xs py-8">
                {projects.length === 0 ? "Нет проектов. Создайте первый!" : "Ничего не найдено"}
              </li>
            )}
          </ul>
        </aside>

        {/* Right Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden bg-surface-1/30">
          {selectedId && hub ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Project Header */}
              <div className="p-4 lg:px-6 lg:py-4 border-b border-border bg-surface-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-text-primary flex items-center gap-2">
                    <span>📁</span> {hub.project.name}
                  </h2>
                  {hub.project.description && (
                    <p className="text-xs text-text-secondary mt-0.5">{hub.project.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    ref={fileInputRef}
                    multiple
                    accept="video/*"
                    className="hidden"
                    onChange={(e) => handleFileUpload(e.target.files)}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    loading={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    + Загрузить сырое видео
                  </Button>
                </div>
              </div>

              {/* Upload progress banner */}
              {uploading && (
                <div className="bg-brand-500/10 border-b border-brand-500/20 px-6 py-2.5 flex items-center gap-3 animate-slide-up">
                  <LoadingSpinner size={16} />
                  <div className="flex-1">
                    <div className="flex justify-between text-2xs font-medium text-brand-400 mb-1">
                      <span>Загрузка видео в проект…</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <Progress value={uploadProgress} max={100} className="h-1.5" />
                  </div>
                </div>
              )}

              {/* Hub Tabs Navigation */}
              <div className="flex border-b border-border bg-surface-0 px-4 lg:px-6 gap-1 overflow-x-auto">
                <button
                  onClick={() => setActiveTab("raw")}
                  className={cn(
                    "px-3 py-2.5 text-xs font-semibold border-b-2 transition-all flex items-center gap-1.5 whitespace-nowrap",
                    activeTab === "raw"
                      ? "border-brand-500 text-brand-400"
                      : "border-transparent text-text-secondary hover:text-text-primary",
                  )}
                >
                  <span>1. Сырые видео</span>
                  <Badge variant="outline" className="text-3xs py-0 px-1.5">
                    {hub.rawVideos.length}
                  </Badge>
                </button>

                <button
                  onClick={() => setActiveTab("master")}
                  className={cn(
                    "px-3 py-2.5 text-xs font-semibold border-b-2 transition-all flex items-center gap-1.5 whitespace-nowrap",
                    activeTab === "master"
                      ? "border-brand-500 text-brand-400"
                      : "border-transparent text-text-secondary hover:text-text-primary",
                  )}
                >
                  <span>2. Готовые мастер-ролики</span>
                  <Badge variant="outline" className="text-3xs py-0 px-1.5">
                    {hub.masterClips.length}
                  </Badge>
                </button>

                <button
                  onClick={() => setActiveTab("uniquified")}
                  className={cn(
                    "px-3 py-2.5 text-xs font-semibold border-b-2 transition-all flex items-center gap-1.5 whitespace-nowrap",
                    activeTab === "uniquified"
                      ? "border-brand-500 text-brand-400"
                      : "border-transparent text-text-secondary hover:text-text-primary",
                  )}
                >
                  <span>3. Уникализированные варианты</span>
                  <Badge variant="outline" className="text-3xs py-0 px-1.5">
                    {hub.uniqueVariants.length}
                  </Badge>
                </button>

                <button
                  onClick={() => setActiveTab("distributions")}
                  className={cn(
                    "px-3 py-2.5 text-xs font-semibold border-b-2 transition-all flex items-center gap-1.5 whitespace-nowrap",
                    activeTab === "distributions"
                      ? "border-brand-500 text-brand-400"
                      : "border-transparent text-text-secondary hover:text-text-primary",
                  )}
                >
                  <span>4. Автопубликация и ферма</span>
                  <Badge variant="outline" className="text-3xs py-0 px-1.5">
                    {hub.distributeJobs.length}
                  </Badge>
                </button>
              </div>

              {/* Tab 1: Raw Videos */}
              {activeTab === "raw" && (
                <div className="flex-1 flex flex-col overflow-hidden">
                  {/* Action Bar for Selected Raw Videos */}
                  {hub.rawVideos.length > 0 && (
                    <div className="px-4 lg:px-6 py-2 border-b border-border bg-surface-0/60 flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={selectAllRaw}
                          className="text-text-secondary hover:text-text-primary text-xs underline"
                        >
                          {selectedRawVideoIds.length === hub.rawVideos.length
                            ? "Снять выбор"
                            : "Выбрать все"}
                        </button>
                        <span className="text-text-tertiary">
                          (Выбрано: {selectedRawVideoIds.length} из {hub.rawVideos.length})
                        </span>
                      </div>

                      <Button
                        variant="primary"
                        size="xs"
                        disabled={selectedRawVideoIds.length === 0}
                        onClick={handleOpenInEditor}
                      >
                        🎬 Смонтировать в Умном Редакторе ({selectedRawVideoIds.length})
                      </Button>
                    </div>
                  )}

                  <div className="flex-1 overflow-y-auto p-4 lg:p-6">
                    {hub.rawVideos.length === 0 ? (
                      <div className="border-2 border-dashed border-border rounded-xl p-10 text-center bg-surface-0">
                        <p className="text-3xl mb-2">📹</p>
                        <h3 className="text-sm font-semibold text-text-primary mb-1">
                          В проекте пока нет сырых видео
                        </h3>
                        <p className="text-xs text-text-tertiary max-w-md mx-auto mb-4">
                          Загрузите отснятые видео товара, демонстрации или B-roll кадры. Далее вы
                          сможете отправить их в Умный Редактор для качественного монтажа.
                        </p>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          Загрузить видеофайлы
                        </Button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
                        {hub.rawVideos.map((video) => {
                          const isSelected = selectedRawVideoIds.includes(video.id);
                          return (
                            <div
                              key={video.id}
                              className={cn(
                                "rounded-xl border overflow-hidden bg-surface-0 transition-all shadow-sm",
                                isSelected
                                  ? "border-brand-500 ring-2 ring-brand-500/20"
                                  : "border-border hover:border-border/80",
                              )}
                            >
                              {/* Video Preview */}
                              <div className="relative aspect-video bg-black/80 flex items-center justify-center">
                                {video.url ? (
                                  <video
                                    src={video.url}
                                    className="w-full h-full object-cover"
                                    controls
                                    preload="metadata"
                                  />
                                ) : (
                                  <span className="text-xs text-text-tertiary">Видео обрабатывается</span>
                                )}

                                {/* Checkbox overlay */}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleRawSelect(video.id);
                                  }}
                                  className={cn(
                                    "absolute top-2 left-2 w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold transition-all shadow-md",
                                    isSelected
                                      ? "bg-brand-500 text-white"
                                      : "bg-black/60 text-white/80 hover:bg-black/80",
                                  )}
                                >
                                  {isSelected ? "✓" : ""}
                                </button>
                              </div>

                              {/* Info */}
                              <div className="p-3">
                                <p className="text-xs font-semibold text-text-primary truncate" title={video.title}>
                                  {video.title}
                                </p>
                                <div className="flex items-center justify-between text-3xs text-text-tertiary mt-1.5">
                                  <span>
                                    {video.durationSec ? `${Math.round(Number(video.durationSec))} сек` : "—"}
                                    {video.width && video.height ? ` · ${video.width}×${video.height}` : ""}
                                  </span>
                                  <span>{relativeTime(video.createdAt)}</span>
                                </div>

                                <div className="flex items-center gap-1.5 mt-3 pt-2.5 border-t border-border">
                                  <Button
                                    variant="secondary"
                                    size="xs"
                                    className="flex-1 text-3xs"
                                    onClick={() => handleOpenInUniquify(video.id)}
                                  >
                                    ⚡ Уникализировать
                                  </Button>
                                  <button
                                    onClick={() => handleDeleteRawVideo(video.id)}
                                    className="p-1 text-text-tertiary hover:text-danger rounded transition-colors"
                                    title="Удалить"
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <polyline points="3 6 5 6 21 6" />
                                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Tab 2: Master Clips from Smart Editor */}
              {activeTab === "master" && (
                <div className="flex-1 overflow-y-auto p-4 lg:p-6">
                  {hub.masterClips.length === 0 ? (
                    <div className="border border-border rounded-xl p-10 text-center bg-surface-0">
                      <p className="text-3xl mb-2">🎬</p>
                      <h3 className="text-sm font-semibold text-text-primary mb-1">
                        Мастер-роликов пока нет
                      </h3>
                      <p className="text-xs text-text-tertiary max-w-md mx-auto mb-4">
                        Смонтируйте качественный ролик в Умном Редакторе: субтитры караоке, вырезка лучших моментов, нормализация звука. Готовые видео автоматически сохранятся здесь.
                      </p>
                      <Button variant="primary" size="sm" onClick={handleOpenInEditor}>
                        Перейти в Умный Редактор
                      </Button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                      {hub.masterClips.map((clip) => (
                        <div
                          key={clip.id}
                          className="rounded-xl border border-border bg-surface-0 overflow-hidden shadow-sm flex flex-col"
                        >
                          <div className="relative aspect-video bg-black flex items-center justify-center">
                            {clip.url ? (
                              <video
                                src={clip.url}
                                controls
                                poster={clip.thumbnailUrl ?? undefined}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <span className="text-xs text-text-tertiary">Рендерится…</span>
                            )}
                            <span className="absolute top-2 right-2 rounded bg-brand-500/90 text-white text-3xs font-bold px-1.5 py-0.5">
                              Мастер
                            </span>
                          </div>

                          <div className="p-3 flex-1 flex flex-col justify-between">
                            <div>
                              <p className="text-xs font-semibold text-text-primary truncate">
                                {clip.title || "Мастер-ролик"}
                              </p>
                              {clip.transcriptSnippet && (
                                <p className="text-2xs text-text-secondary mt-1 line-clamp-2">
                                  «{clip.transcriptSnippet}»
                                </p>
                              )}
                              <p className="text-3xs text-text-tertiary mt-1.5">
                                {clip.durationSec ? `${Math.round(Number(clip.durationSec))} сек` : ""}
                                {clip.project?.mode ? ` · ${clip.project.mode}` : ""}
                              </p>
                            </div>

                            <div className="flex items-center gap-2 mt-4 pt-3 border-t border-border">
                              {clip.outputSourceVideoId ? (
                                <Button
                                  variant="primary"
                                  size="xs"
                                  className="flex-1"
                                  onClick={() => handleOpenInUniquify(clip.outputSourceVideoId!)}
                                >
                                  ⚡ Создать уникальные варианты
                                </Button>
                              ) : (
                                <Button
                                  variant="primary"
                                  size="xs"
                                  className="flex-1"
                                  onClick={() => router.push(`/editor/${clip.project.id}`)}
                                >
                                  Открыть в редакторе
                                </Button>
                              )}
                              {clip.url && (
                                <a
                                  href={clip.url}
                                  download
                                  className="text-xs text-brand-400 hover:underline px-2 py-1"
                                >
                                  Скачать
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Tab 3: Unique Variants */}
              {activeTab === "uniquified" && (
                <div className="flex-1 overflow-y-auto p-4 lg:p-6">
                  {hub.uniqueVariants.length === 0 ? (
                    <div className="border border-border rounded-xl p-10 text-center bg-surface-0">
                      <p className="text-3xl mb-2">⚡</p>
                      <h3 className="text-sm font-semibold text-text-primary mb-1">
                        Уникализированных вариантов пока нет
                      </h3>
                      <p className="text-xs text-text-tertiary max-w-md mx-auto mb-4">
                        Выберите мастер-ролик и создайте пакет уникальных видео в режиме «Сохранение контекста».
                      </p>
                      <Button variant="primary" size="sm" onClick={() => setActiveTab("master")}>
                        К готовым роликам
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-text-secondary">
                          Всего вариантов: <b className="text-text-primary">{hub.uniqueVariants.length}</b>
                        </p>
                        {hub.uniqueVariants.length > 0 && (
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => handleOpenDistribution(hub.uniqueVariants[0].uniquifyJob.id)}
                          >
                            🚀 Настроить сетку автопубликации
                          </Button>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
                        {hub.uniqueVariants.map((variant) => (
                          <div
                            key={variant.id}
                            className="rounded-xl border border-border bg-surface-0 overflow-hidden shadow-sm flex flex-col"
                          >
                            <div className="relative aspect-[9/16] bg-black flex items-center justify-center max-h-[320px]">
                              {variant.url ? (
                                <video
                                  src={variant.url}
                                  controls
                                  poster={variant.thumbnailUrl ?? undefined}
                                  className="w-full h-full object-contain"
                                />
                              ) : (
                                <span className="text-xs text-text-tertiary">Рендер варианта…</span>
                              )}
                              <span className="absolute top-2 left-2 rounded bg-black/70 text-white text-3xs font-mono px-1.5 py-0.5">
                                Вариант #{variant.variantIndex + 1}
                              </span>
                            </div>

                            <div className="p-3 flex-1 flex flex-col justify-between">
                              <div>
                                <div className="flex items-center justify-between text-3xs text-text-tertiary">
                                  <span>{variant.durationSec ? `${variant.durationSec} сек` : ""}</span>
                                  <StatusBadge status={variant.status as any} />
                                </div>
                              </div>

                              <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-border">
                                {variant.url && (
                                  <a
                                    href={variant.url}
                                    download
                                    className="text-2xs font-medium text-brand-400 hover:underline"
                                  >
                                    Скачать MP4
                                  </a>
                                )}
                                <div className="flex-1" />
                                <Button
                                  variant="secondary"
                                  size="xs"
                                  onClick={() => handleOpenDistribution(variant.uniquifyJob.id)}
                                >
                                  Раздать
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 4: Distributions */}
              {activeTab === "distributions" && (
                <div className="flex-1 overflow-y-auto p-4 lg:p-6">
                  {hub.distributeJobs.length === 0 ? (
                    <div className="border border-border rounded-xl p-10 text-center bg-surface-0">
                      <p className="text-3xl mb-2">📱</p>
                      <h3 className="text-sm font-semibold text-text-primary mb-1">
                        Раздач публикаций пока не создано
                      </h3>
                      <p className="text-xs text-text-tertiary max-w-md mx-auto mb-4">
                        После генерации уникальных вариантов вы можете настроить автоматическую отправку роликов на ферму телефонов.
                      </p>
                      <Button variant="primary" size="sm" onClick={() => setActiveTab("uniquified")}>
                        К уникализированным вариантам
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {hub.distributeJobs.map((dist) => (
                        <Card key={dist.id}>
                          <CardContent className="p-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-sm text-text-primary">
                                  Раздача #{dist.id.slice(0, 8)}
                                </span>
                                <StatusBadge status={dist.status as any} />
                              </div>
                              <span className="text-2xs text-text-tertiary">
                                {relativeTime(dist.createdAt)}
                              </span>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                              <div className="p-2 rounded-lg bg-surface-2">
                                <span className="text-text-tertiary text-3xs">Всего постов:</span>
                                <p className="font-bold text-text-primary">{dist.totalItems}</p>
                              </div>
                              <div className="p-2 rounded-lg bg-surface-2">
                                <span className="text-text-tertiary text-3xs">Опубликовано:</span>
                                <p className="font-bold text-success">{dist.publishedCount}</p>
                              </div>
                              <div className="p-2 rounded-lg bg-surface-2">
                                <span className="text-text-tertiary text-3xs">Интервал:</span>
                                <p className="font-bold text-text-primary">{dist.staggerMinutes} мин</p>
                              </div>
                              <div className="p-2 rounded-lg bg-surface-2">
                                <span className="text-text-tertiary text-3xs">Ошибок:</span>
                                <p className="font-bold text-danger">{dist.failedCount}</p>
                              </div>
                            </div>

                            {/* Items table preview */}
                            <div className="border border-border rounded-lg overflow-hidden text-2xs">
                              <table className="w-full text-left">
                                <thead className="bg-surface-2 text-text-tertiary">
                                  <tr>
                                    <th className="p-2">Аккаунт</th>
                                    <th className="p-2">Плата фермы</th>
                                    <th className="p-2">Время</th>
                                    <th className="p-2">Статус</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                  {dist.items.slice(0, 5).map((item) => (
                                    <tr key={item.id} className="hover:bg-surface-2/40">
                                      <td className="p-2 font-medium text-text-primary">
                                        {item.socialAccount?.accountName ?? "—"} ({item.socialAccount?.platform})
                                      </td>
                                      <td className="p-2 font-mono text-text-secondary">
                                        {item.socialAccount?.deviceId ?? "API/Cloud"}
                                      </td>
                                      <td className="p-2 text-text-tertiary">
                                        {item.scheduledAt ? relativeTime(item.scheduledAt) : "Сразу"}
                                      </td>
                                      <td className="p-2">
                                        <StatusBadge status={item.status as any} />
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {dist.items.length > 5 && (
                                <div className="p-2 text-center text-3xs text-text-tertiary bg-surface-2/50">
                                  и ещё {dist.items.length - 5} назначений…
                                </div>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : selectedId && hubLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <LoadingSpinner size={32} />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-8 text-center text-text-tertiary text-sm">
              Выберите проект слева или создайте новый
            </div>
          )}
        </div>
      </main>

      {/* Modal: Create Project */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-surface-1 border border-border rounded-xl p-6 w-full max-w-md shadow-elevation-3 animate-slide-up">
            <h3 className="text-base font-bold text-text-primary mb-4">Создать новый проект</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  Название проекта *
                </label>
                <Input
                  placeholder="Например: Наушники Pro / Съемка 1"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  Описание (опционально)
                </label>
                <Input
                  placeholder="Коротко о товаре или сценарии"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
                Отмена
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
              >
                {creating ? "Создание…" : "Создать проект"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

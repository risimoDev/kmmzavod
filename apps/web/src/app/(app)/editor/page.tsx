"use client";

/**
 * Умный редактор — список проектов монтажа + мастер создания.
 * Интегрирован с рабочими проектами: импорт отснятых видео без повторной загрузки.
 */
import { Suspense, useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  LoadingSpinner,
  Card,
  CardContent,
  Input,
  EmptyState,
  Badge,
} from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime, cn } from "@/lib/utils";
import {
  editorApi,
  projectsApi,
  type EditProject,
  type EditMode,
  type EditGeometry,
  type EditAspect,
  type EditAudioMode,
  type Project,
  type SourceVideo,
} from "@/lib/api";

const MODES: { value: EditMode; label: string; hint: string; icon: string }[] = [
  { value: "smart_montage", label: "Интеллектуальный монтаж", icon: "🎬", hint: "Готовое видео: субтитры по речи, переходы, smart-crop" },
  { value: "uniquify_source", label: "Нарезка под уникализацию", icon: "✂️", hint: "Сырьё для системы уникализации (без субтитров)" },
];

const GEOMETRIES: { value: EditGeometry; label: string; hint: string; icon: string }[] = [
  { value: "highlights", label: "Длинное → шортсы", icon: "🎯", hint: "ИИ найдёт N лучших моментов в 1 длинном видео" },
  { value: "mix", label: "Микс N видео → одно", icon: "🎛️", hint: "Один динамичный ролик из лучших кусков нескольких" },
];

const ASPECTS: { value: EditAspect; w: number; h: number; hint: string }[] = [
  { value: "9:16", w: 18, h: 32, hint: "Reels / TikTok" },
  { value: "4:5", w: 24, h: 30, hint: "Лента IG" },
  { value: "1:1", w: 28, h: 28, hint: "Квадрат" },
  { value: "16:9", w: 36, h: 21, hint: "YouTube" },
];

const SUBTITLE_STYLES: { value: string; label: string; cls: string }[] = [
  { value: "tiktok", label: "TikTok", cls: "font-black text-warning" },
  { value: "cinematic", label: "Cinema", cls: "font-medium text-text-primary" },
  { value: "minimal", label: "Minimal", cls: "font-light text-text-secondary" },
  { value: "default", label: "Классика", cls: "font-bold text-brand-400" },
  { value: "none", label: "Выкл", cls: "text-text-tertiary line-through" },
];

type PresetPatch = Partial<Pick<EditProject,
  "mode" | "geometry" | "aspect" | "audioMode" | "subtitleStyle" |
  "targetClipCount" | "targetClipSeconds">> & { name: string };

const PRESETS: { label: string; icon: string; hint: string; patch: PresetPatch }[] = [
  { label: "Хайлайты из подкаста", icon: "🎙️", hint: "5 лучших моментов × 30с, karaoke-субтитры",
    patch: { name: "Хайлайты", mode: "smart_montage", geometry: "highlights", aspect: "9:16", subtitleStyle: "tiktok", audioMode: "keep", targetClipCount: 5, targetClipSeconds: 30 } },
  { label: "Динамичный микс", icon: "⚡", hint: "Один ролик из лучших битов, beat-sync",
    patch: { name: "Микс", mode: "smart_montage", geometry: "mix", aspect: "9:16", subtitleStyle: "tiktok", audioMode: "keep", targetClipSeconds: 25 } },
  { label: "Сырьё для уникализации", icon: "🏭", hint: "Нарезка без субтитров → в конвейер фермы",
    patch: { name: "Уникализация", mode: "uniquify_source", geometry: "mix", aspect: "9:16", subtitleStyle: "none", audioMode: "keep", targetClipSeconds: 30 } },
];

function Slider({ label, value, min, max, unit, onChange }: {
  label: string; value: number; min: number; max: number; unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-text-secondary">{label}</span>
        <span className="font-mono text-brand-400 font-semibold">{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brand-500" />
    </div>
  );
}

function Toggle({ checked, onChange, children }: {
  checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={cn(
        "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
        checked
          ? "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30"
          : "bg-surface-2 text-text-secondary hover:text-text-primary"
      )}>
      {checked ? "✓ " : ""}{children}
    </button>
  );
}

export default function EditorProjectsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center">
          <LoadingSpinner size={32} />
        </div>
      }
    >
      <EditorProjectsContent />
    </Suspense>
  );
}

function EditorProjectsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [projects, setProjects] = useState<EditProject[]>([]);
  const [workspaceProjects, setWorkspaceProjects] = useState<Project[]>([]);
  const [selectedWorkspaceProjectId, setSelectedWorkspaceProjectId] = useState<string>("");
  const [availableSourceVideos, setAvailableSourceVideos] = useState<SourceVideo[]>([]);
  const [selectedSourceVideoIds, setSelectedSourceVideoIds] = useState<string[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);

  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [mode, setMode] = useState<EditMode>("smart_montage");
  const [geometry, setGeometry] = useState<EditGeometry>("highlights");
  const [aspect, setAspect] = useState<EditAspect>("9:16");
  const [audioMode, setAudioMode] = useState<EditAudioMode>("keep");
  const [subtitleStyle, setSubtitleStyle] = useState("tiktok");
  const [smartCrop, setSmartCrop] = useState(true);
  const [useVision, setUseVision] = useState(false);
  const [targetClipCount, setTargetClipCount] = useState(5);
  const [targetClipSeconds, setTargetClipSeconds] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ projects }, wsProjects] = await Promise.all([
        editorApi.listProjects(),
        projectsApi.list().catch(() => [] as Project[]),
      ]);
      setProjects(projects);
      setWorkspaceProjects(wsProjects);

      // Check query params
      const queryProjectId = searchParams.get("projectId");
      const querySources = searchParams.get("sources");
      if (queryProjectId) {
        setShowCreate(true);
        setSelectedWorkspaceProjectId(queryProjectId);
        if (querySources) {
          setSelectedSourceVideoIds(querySources.split(",").filter(Boolean));
        }
      } else if (projects.length === 0) {
        setShowCreate(true);
      }
    } catch {
      setShowCreate(true);
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  useEffect(() => { void load(); }, [load]);

  // When workspace project selected, load its source videos
  useEffect(() => {
    if (!selectedWorkspaceProjectId) {
      setAvailableSourceVideos([]);
      return;
    }
    setLoadingSources(true);
    projectsApi
      .hub(selectedWorkspaceProjectId)
      .then((hub) => {
        setAvailableSourceVideos(hub.rawVideos);
      })
      .catch(() => setAvailableSourceVideos([]))
      .finally(() => setLoadingSources(false));
  }, [selectedWorkspaceProjectId]);

  function applyPreset(label: string, patch: PresetPatch) {
    setActivePreset(label);
    if (!name.trim()) setName(patch.name);
    if (patch.mode) setMode(patch.mode);
    if (patch.geometry) setGeometry(patch.geometry);
    if (patch.aspect) setAspect(patch.aspect);
    if (patch.audioMode) setAudioMode(patch.audioMode);
    if (patch.subtitleStyle !== undefined) setSubtitleStyle(patch.subtitleStyle);
    if (patch.targetClipCount) setTargetClipCount(patch.targetClipCount);
    if (patch.targetClipSeconds) setTargetClipSeconds(patch.targetClipSeconds);
  }

  const toggleSourceVideo = (id: string) => {
    setSelectedSourceVideoIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const p = await editorApi.createProject({
        name: name.trim(),
        mode,
        geometry,
        aspect,
        audioMode,
        subtitleStyle,
        smartCrop,
        useVision,
        targetClipCount,
        targetClipSeconds,
        workspaceProjectId: selectedWorkspaceProjectId || undefined,
        ...(selectedWorkspaceProjectId ? { config: { workspaceProjectId: selectedWorkspaceProjectId } } : {}),
      });

      // If user selected source videos from the workspace project, import them directly
      if (selectedSourceVideoIds.length > 0) {
        await editorApi.importSourcesFromWorkspaceVideo(p.id, selectedSourceVideoIds).catch(() => {});
      }

      router.push(`/editor/${p.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function removeProject(e: React.MouseEvent, p: EditProject) {
    e.stopPropagation();
    if (!confirm(`Удалить проект «${p.name}» со всеми клипами?`)) return;
    await editorApi.remove(p.id);
    setProjects((prev) => prev.filter((x) => x.id !== p.id));
  }

  return (
    <div className="flex flex-col h-full">
      <TopBar
        title="Умный редактор"
        subtitle="Интеллектуальная нарезка и профессиональный монтаж"
        actions={
          <Button variant={showCreate ? "secondary" : "primary"} size="sm"
            onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Скрыть мастер" : "+ Новый проект монтажа"}
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-6 space-y-6 animate-slide-up">
        {showCreate && (
          <Card className="shadow-elevation-2">
            <CardContent className="p-5 space-y-5">
              {/* Шаг 1 — пресет */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">
                  1 · Быстрый старт (пресеты)
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {PRESETS.map((p) => (
                    <button key={p.label} type="button"
                      onClick={() => applyPreset(p.label, p.patch)}
                      className={cn(
                        "text-left rounded-xl border p-3 transition-all hover:shadow-elevation-1",
                        activePreset === p.label
                          ? "border-brand-500/60 bg-brand-500/10 shadow-brand-glow-sm"
                          : "border-border bg-surface-2 hover:border-brand-500/30"
                      )}>
                      <div className="text-xl">{p.icon}</div>
                      <div className="mt-1 text-sm font-semibold text-text-primary">{p.label}</div>
                      <div className="text-xs text-text-secondary">{p.hint}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Шаг 2 — привязка к проекту и исходные видео */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">
                  2 · Проект и исходные видео
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-2xs text-text-tertiary mb-1">
                      Название проекта монтажа *
                    </label>
                    <Input placeholder="Например: Наушники Pro — Лучшие моменты" value={name}
                      onChange={(e) => setName(e.target.value)} />
                  </div>

                  <div>
                    <label className="block text-2xs text-text-tertiary mb-1">
                      Привязать к проекту (Workspace)
                    </label>
                    <select
                      value={selectedWorkspaceProjectId}
                      onChange={(e) => setSelectedWorkspaceProjectId(e.target.value)}
                      className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-500/50"
                    >
                      <option value="">(Без привязки или выбрать проект)</option>
                      {workspaceProjects.map((wp) => (
                        <option key={wp.id} value={wp.id}>
                          📁 {wp.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Video Selector from Chosen Workspace Project */}
                {selectedWorkspaceProjectId && (
                  <div className="rounded-xl border border-border bg-surface-2/40 p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-text-primary">
                        Исходные видео из проекта ({selectedSourceVideoIds.length} выбрано)
                      </span>
                      {availableSourceVideos.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            if (selectedSourceVideoIds.length === availableSourceVideos.length) {
                              setSelectedSourceVideoIds([]);
                            } else {
                              setSelectedSourceVideoIds(availableSourceVideos.map((v) => v.id));
                            }
                          }}
                          className="text-brand-400 hover:underline text-2xs"
                        >
                          {selectedSourceVideoIds.length === availableSourceVideos.length
                            ? "Снять выбор"
                            : "Выбрать все"}
                        </button>
                      )}
                    </div>

                    {loadingSources ? (
                      <div className="py-4 text-center text-xs text-text-tertiary">
                        Загрузка видео из проекта…
                      </div>
                    ) : availableSourceVideos.length === 0 ? (
                      <div className="py-4 text-center text-xs text-text-tertiary">
                        В этом проекте пока нет загруженных видео. Вы сможете загрузить их прямо в редакторе.
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 max-h-48 overflow-y-auto p-1">
                        {availableSourceVideos.map((sv) => {
                          const isChecked = selectedSourceVideoIds.includes(sv.id);
                          return (
                            <button
                              key={sv.id}
                              type="button"
                              onClick={() => toggleSourceVideo(sv.id)}
                              className={cn(
                                "text-left rounded-lg p-2 border transition-all text-xs flex flex-col justify-between",
                                isChecked
                                  ? "border-brand-500/60 bg-brand-500/15"
                                  : "border-border bg-surface-1 hover:border-border/80"
                              )}
                            >
                              <div className="flex items-start justify-between gap-1 mb-1">
                                <span className="font-medium text-text-primary truncate">{sv.title}</span>
                                <span className={cn(
                                  "w-4 h-4 rounded text-3xs flex items-center justify-center font-bold",
                                  isChecked ? "bg-brand-500 text-white" : "bg-surface-3 text-text-tertiary"
                                )}>
                                  {isChecked ? "✓" : ""}
                                </span>
                              </div>
                              <span className="text-3xs text-text-tertiary">
                                {sv.durationSec ? `${Math.round(Number(sv.durationSec))}с` : "—"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Шаг 3 — что делаем */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">
                  3 · Режим монтажа и геометрия
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[
                    { items: MODES, value: mode, set: (v: string) => setMode(v as EditMode) },
                    { items: GEOMETRIES, value: geometry, set: (v: string) => setGeometry(v as EditGeometry) },
                  ].map(({ items, value, set }, col) => (
                    <div key={col} className="space-y-1.5">
                      {items.map((m) => (
                        <button key={m.value} type="button" onClick={() => set(m.value)}
                          className={cn(
                            "w-full text-left rounded-lg border p-2.5 text-sm transition-all flex gap-2.5 items-start",
                            value === m.value
                              ? "border-brand-500/60 bg-brand-500/10"
                              : "border-border hover:border-brand-500/30"
                          )}>
                          <span className="text-lg leading-none mt-0.5">{m.icon}</span>
                          <span>
                            <span className="block font-medium text-text-primary">{m.label}</span>
                            <span className="block text-xs text-text-secondary">{m.hint}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* Шаг 4 — формат и стиль */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">
                  4 · Формат, звук и субтитры
                </p>
                <div className="flex flex-wrap items-end gap-5">
                  <div className="flex gap-2">
                    {ASPECTS.map((a) => (
                      <button key={a.value} type="button" onClick={() => setAspect(a.value)}
                        title={a.hint}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-lg p-2 transition-all",
                          aspect === a.value ? "bg-brand-500/15 ring-1 ring-brand-500/40" : "hover:bg-surface-2"
                        )}>
                        <span
                          className={cn("rounded-sm border-2",
                            aspect === a.value ? "border-brand-400 bg-brand-500/30" : "border-text-tertiary")}
                          style={{ width: a.w, height: a.h }} />
                        <span className="text-2xs text-text-secondary">{a.value}</span>
                      </button>
                    ))}
                  </div>

                  <div className="flex gap-1.5">
                    {SUBTITLE_STYLES.map((s) => (
                      <button key={s.value} type="button" onClick={() => setSubtitleStyle(s.value)}
                        className={cn(
                          "px-3 py-2 rounded-lg text-sm transition-all",
                          subtitleStyle === s.value
                            ? "bg-brand-500/15 ring-1 ring-brand-500/40"
                            : "bg-surface-2 hover:bg-surface-3"
                        )}>
                        <span className={s.cls}>Aa</span>
                        <span className="block text-2xs text-text-secondary">{s.label}</span>
                      </button>
                    ))}
                  </div>

                  <div className="flex gap-1.5">
                    <Toggle checked={audioMode === "keep"} onChange={() => setAudioMode("keep")}>Ориг. звук</Toggle>
                    <Toggle checked={audioMode === "replace"} onChange={() => setAudioMode("replace")}>Озвучка+музыка</Toggle>
                  </div>
                </div>
              </div>

              {/* Шаг 5 — параметры длительности */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">
                  5 · Параметры хронометража
                </p>
                <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2 max-w-xl">
                  <Slider label="Длина клипа" value={targetClipSeconds} min={5} max={90} unit="с"
                    onChange={setTargetClipSeconds} />
                  {geometry === "highlights" && (
                    <Slider label="Сколько клипов" value={targetClipCount} min={1} max={12} unit=""
                      onChange={setTargetClipCount} />
                  )}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Toggle checked={smartCrop} onChange={setSmartCrop}>Кроп центрирует на объекте</Toggle>
                  <Toggle checked={useVision} onChange={setUseVision}>ИИ-анализ кадров (gpt-4o)</Toggle>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button variant="primary" onClick={create} loading={creating} disabled={!name.trim()}>
                  Создать проект монтажа
                </Button>
                {!name.trim() && (
                  <span className="text-xs text-text-tertiary">Укажите название проекта</span>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {loading ? (
          <div className="flex justify-center py-12"><LoadingSpinner size={28} /></div>
        ) : projects.length === 0 ? (
          !showCreate && <EmptyState title="Нет проектов" description="Создайте первый проект редактора." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Card key={p.id} hoverable
                className="cursor-pointer group transition-all hover:shadow-elevation-2 hover:border-brand-500/40"
                onClick={() => router.push(`/editor/${p.id}`)}>
                <CardContent className="p-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-medium truncate text-text-primary">
                      {p.mode === "smart_montage" ? "🎬" : "✂️"} {p.name}
                    </h4>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{p.geometry === "highlights" ? "хайлайты" : "микс"}</Badge>
                    <Badge variant="outline">{p.aspect}</Badge>
                    {p.subtitleStyle !== "none" && <Badge variant="brand">субтитры</Badge>}
                  </div>
                  <div className="flex items-center justify-between text-xs text-text-tertiary">
                    <span>
                      {p._count?.sources ?? 0} источн. · {p._count?.clips ?? 0} клип. · {relativeTime(p.createdAt)}
                    </span>
                    <button
                      onClick={(e) => removeProject(e, p)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-danger hover:underline"
                    >
                      удалить
                    </button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

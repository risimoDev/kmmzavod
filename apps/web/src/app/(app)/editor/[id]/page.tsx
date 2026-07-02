"use client";

/**
 * Воркспейс проекта редактора: загрузка (drag&drop) → анализ → раскадровка
 * (правка/реордер/выбор) → рендер → готовые клипы. Прогресс — степпером.
 */
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  LoadingSpinner,
  Badge,
  Card,
  CardContent,
  EmptyState,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import {
  editorApi,
  type EditProjectDetail,
  type EditClip,
  type EditOutput,
} from "@/lib/api";

const POLL_MS = 4000;

const STEPS = [
  { key: "sources", label: "Источники" },
  { key: "analyze", label: "Анализ" },
  { key: "storyboard", label: "Раскадровка" },
  { key: "render", label: "Рендер" },
  { key: "done", label: "Готово" },
] as const;

function stepIndex(p: EditProjectDetail): number {
  switch (p.status) {
    case "draft": return p.sources.length === 0 ? 0 : 1;
    case "analyzing": return 1;
    case "ready": return 2;
    case "rendering": return 3;
    case "completed": return 4;
    default: return 0; // failed — показываем баннер отдельно
  }
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clipDuration(c: EditClip): number {
  if (c.durationSec) return Number(c.durationSec);
  return (c.edl?.segments ?? []).reduce((acc, s) => acc + (s.end - s.start), 0);
}

function Stepper({ active, failed }: { active: number; failed: boolean }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {STEPS.map((s, i) => (
        <div key={s.key} className="flex items-center gap-1">
          {i > 0 && <div className={cn("w-6 h-px", i <= active ? "bg-brand-500" : "bg-border")} />}
          <div className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all",
            failed && i === active
              ? "bg-danger/10 text-danger ring-1 ring-danger/30"
              : i < active
              ? "bg-brand-500/10 text-brand-400"
              : i === active
              ? "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/40"
              : "bg-surface-2 text-text-tertiary"
          )}>
            <span className={cn(
              "w-4 h-4 rounded-full text-2xs flex items-center justify-center font-bold",
              i < active ? "bg-brand-500 text-white" : i === active ? "bg-brand-500/30" : "bg-surface-3"
            )}>
              {i < active ? "✓" : i + 1}
            </span>
            {s.label}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function EditorProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<EditProjectDetail | null>(null);
  const [outputs, setOutputs] = useState<EditOutput[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const p = await editorApi.getProject(id);
      setProject(p);
      if (p.status === "completed") {
        const { outputs } = await editorApi.outputs(id);
        setOutputs(outputs);
      }
    } catch {
      // сеть/бэкенд: не роняем страницу, поллинг попробует снова
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!project) return;
    if (project.status !== "analyzing" && project.status !== "rendering") return;
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [project, load]);

  async function onUpload(files: FileList | File[] | null) {
    const list = files ? Array.from(files).filter((f) => f.type.startsWith("video/")) : [];
    if (!list.length) return;
    setUploading({ done: 0, total: list.length });
    try {
      for (let i = 0; i < list.length; i++) {
        await editorApi.uploadSource(id, list[i]);
        setUploading({ done: i + 1, total: list.length });
      }
      await load();
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function analyze() {
    if (project && project.clips.length > 0 &&
        !confirm("Повторный анализ пересоберёт раскадровку. Продолжить?")) return;
    setBusy(true);
    try { await editorApi.analyze(id); await load(); } finally { setBusy(false); }
  }

  async function render() {
    setBusy(true);
    try { await editorApi.render(id); await load(); } finally { setBusy(false); }
  }

  async function toggleClip(clip: EditClip) {
    const updated = await editorApi.updateClip(id, clip.id, { included: !clip.included });
    setProject((p) => p && {
      ...p, clips: p.clips.map((c) => c.id === clip.id ? { ...c, included: updated.included } : c),
    });
  }

  async function setAll(included: boolean) {
    if (!project) return;
    const targets = project.clips.filter((c) => c.included !== included);
    setProject((p) => p && { ...p, clips: p.clips.map((c) => ({ ...c, included })) });
    await Promise.all(targets.map((c) => editorApi.updateClip(id, c.id, { included })));
  }

  async function renameClip(clip: EditClip, title: string) {
    if (title.trim() && title !== clip.title) {
      await editorApi.updateClip(id, clip.id, { title: title.trim() });
    }
  }

  async function moveClip(idx: number, dir: -1 | 1) {
    if (!project) return;
    const clips = [...project.clips];
    const j = idx + dir;
    if (j < 0 || j >= clips.length) return;
    [clips[idx], clips[j]] = [clips[j], clips[idx]];
    setProject({ ...project, clips });
    // Persist swapped order values (optimistic — UI уже переставлен).
    await Promise.all([
      editorApi.updateClip(id, clips[idx].id, { order: idx }),
      editorApi.updateClip(id, clips[j].id, { order: j }),
    ]);
  }

  const included = useMemo(() => project?.clips.filter((c) => c.included) ?? [], [project]);
  const totalSec = useMemo(() => included.reduce((a, c) => a + clipDuration(c), 0), [included]);

  if (!project) {
    return <div className="flex justify-center py-20"><LoadingSpinner size={28} /></div>;
  }

  const isWorking = project.status === "analyzing" || project.status === "rendering";
  const aspectCss = project.aspect.replace(":", "/");
  const showStoryboard = project.clips.length > 0 && project.status !== "analyzing";

  return (
    <div className="flex flex-col h-full">
      <TopBar
        title={project.name}
        subtitle={project.mode === "smart_montage" ? "Интеллектуальный монтаж" : "Нарезка под уникализацию"}
        actions={
          <Button variant="ghost" size="sm" onClick={() => router.push("/editor")}>
            ← К проектам
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-6 pb-24 space-y-5 animate-slide-up">
        {/* Прогресс + конфиг */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <Stepper active={stepIndex(project)} failed={project.status === "failed"} />
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">{project.aspect}</Badge>
            <Badge variant="outline">~{Math.round(Number(project.targetClipSeconds))}с</Badge>
            {project.geometry === "highlights" && <Badge variant="outline">{project.targetClipCount} клип.</Badge>}
            <Badge variant={project.subtitleStyle !== "none" ? "brand" : "outline"}>
              {project.subtitleStyle !== "none" ? `субтитры · ${project.subtitleStyle}` : "без субтитров"}
            </Badge>
            <Badge variant="outline">{project.audioMode === "keep" ? "ориг. звук" : "озвучка"}</Badge>
            {project.smartCrop && <Badge variant="outline">smart-crop</Badge>}
          </div>
        </div>

        {project.status === "failed" && project.error && (
          <Card className="border-danger/40">
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-danger">Ошибка обработки</p>
                <p className="text-xs text-text-secondary mt-0.5 break-all">{project.error}</p>
              </div>
              <Button variant="secondary" size="sm" onClick={analyze} loading={busy}>
                Повторить анализ
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Источники: drag&drop */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-text-primary">
                Источники <span className="text-text-tertiary">({project.sources.length})</span>
              </h3>
              <Button variant="primary" size="sm" loading={busy || project.status === "analyzing"}
                disabled={isWorking || project.sources.length === 0}
                onClick={analyze}>
                {project.clips.length > 0 ? "Анализировать заново" : "🔍 Анализировать"}
              </Button>
            </div>

            <input ref={fileRef} type="file" accept="video/*" multiple hidden
              onChange={(e) => onUpload(e.target.files)} />
            <div
              onClick={() => !uploading && !isWorking && fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault(); setDragOver(false);
                if (!uploading && !isWorking) void onUpload(e.dataTransfer.files);
              }}
              className={cn(
                "rounded-xl border-2 border-dashed p-5 text-center cursor-pointer transition-all",
                dragOver
                  ? "border-brand-500 bg-brand-500/10 shadow-brand-glow-sm"
                  : "border-border hover:border-brand-500/40 hover:bg-surface-2",
                (uploading || isWorking) && "opacity-60 cursor-default"
              )}>
              {uploading ? (
                <span className="text-sm text-text-secondary inline-flex items-center gap-2">
                  <LoadingSpinner size={14} /> Загрузка {uploading.done}/{uploading.total}…
                </span>
              ) : (
                <span className="text-sm text-text-secondary">
                  Перетащите видео сюда или <span className="text-brand-400 font-medium">выберите файлы</span>
                </span>
              )}
            </div>

            {project.sources.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {project.sources.map((s, i) => (
                  <div key={s.id}
                    className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-xs">
                    <span className="w-5 h-5 rounded-full bg-brand-500/15 text-brand-400 font-bold flex items-center justify-center">
                      {i + 1}
                    </span>
                    <span className="text-text-primary font-medium">
                      {s.durationSec ? fmtTime(Number(s.durationSec)) : "…"}
                    </span>
                    {s.width ? <span className="text-text-tertiary">{s.width}×{s.height}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Работа в фоне */}
        {isWorking && (
          <Card className="border-brand-500/30">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-3">
                <LoadingSpinner size={18} />
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {project.status === "analyzing" ? "Анализируем источники…" : "Рендерим клипы…"}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {project.status === "analyzing"
                      ? "Сцены, речь (Whisper), движение, лица, LLM-отбор моментов. На длинных видео — несколько минут."
                      : "Кроп по лицу, переходы, субтитры, звук. Страница обновится сама."}
                  </p>
                </div>
              </div>
              <div className="h-1 rounded-full bg-surface-3 overflow-hidden">
                <div className="h-full w-1/3 rounded-full bg-brand-500/70 animate-shimmer"
                  style={{ backgroundImage: "linear-gradient(90deg, transparent, rgba(255,255,255,.25), transparent)", backgroundSize: "200% 100%" }} />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Раскадровка */}
        {showStoryboard && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h3 className="font-semibold text-text-primary">
                  Раскадровка{" "}
                  <span className="text-text-tertiary font-normal">
                    · {included.length}/{project.clips.length} выбрано · {fmtTime(totalSec)} суммарно
                  </span>
                </h3>
                <div className="flex gap-1.5">
                  <Button variant="ghost" size="xs" onClick={() => setAll(true)}>Все</Button>
                  <Button variant="ghost" size="xs" onClick={() => setAll(false)}>Ничего</Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {project.clips.map((c, idx) => {
                  const seg = c.edl?.segments?.[0];
                  const dur = clipDuration(c);
                  return (
                    <div key={c.id}
                      className={cn(
                        "rounded-xl border overflow-hidden transition-all",
                        c.included
                          ? "border-brand-500/50 shadow-elevation-1"
                          : "border-border opacity-55 grayscale-[35%]"
                      )}>
                      {/* Превью с оверлеями */}
                      <div className="relative bg-surface-3" style={{ aspectRatio: aspectCss }}>
                        {c.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.thumbnailUrl} alt={c.title}
                            className="absolute inset-0 w-full h-full object-cover" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-xs text-text-tertiary">
                            нет превью
                          </div>
                        )}
                        {/* Вкл/выкл */}
                        <button onClick={() => toggleClip(c)}
                          title={c.included ? "Исключить из рендера" : "Включить в рендер"}
                          className={cn(
                            "absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold transition-all",
                            c.included
                              ? "bg-brand-500 text-white shadow-brand-glow-sm"
                              : "bg-black/50 text-white/70 hover:bg-black/70"
                          )}>
                          {c.included ? "✓" : "+"}
                        </button>
                        {/* Таймкод и длительность */}
                        {seg && (
                          <span className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-2xs font-mono text-white">
                            #{seg.src_idx + 1} · {fmtTime(seg.start)}–{fmtTime(seg.end)}
                          </span>
                        )}
                        {dur > 0 && (
                          <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-2xs font-mono text-white">
                            {fmtTime(dur)}
                          </span>
                        )}
                        {/* Score-полоска */}
                        <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40">
                          <div className="h-full bg-gradient-to-r from-brand-500 to-brand-300"
                            style={{ width: `${Math.round(Math.min(1, Number(c.score)) * 100)}%` }} />
                        </div>
                      </div>

                      <div className="p-2.5 space-y-1.5">
                        <input
                          defaultValue={c.title}
                          onBlur={(e) => renameClip(c, e.target.value)}
                          className="w-full bg-transparent text-sm font-medium text-text-primary outline-none rounded px-1 -mx-1 focus:bg-surface-2"
                        />
                        {c.transcriptSnippet && (
                          <p className="text-xs text-text-secondary line-clamp-2 px-1 -mx-1">
                            «{c.transcriptSnippet}»
                          </p>
                        )}
                        <div className="flex items-center justify-between text-2xs text-text-tertiary">
                          <span className="font-mono">score {Number(c.score).toFixed(2)}</span>
                          <span className="flex gap-0.5">
                            <button onClick={() => moveClip(idx, -1)} disabled={idx === 0}
                              className="px-1.5 py-0.5 rounded hover:bg-surface-2 disabled:opacity-30">←</button>
                            <button onClick={() => moveClip(idx, 1)} disabled={idx === project.clips.length - 1}
                              className="px-1.5 py-0.5 rounded hover:bg-surface-2 disabled:opacity-30">→</button>
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Готовые клипы */}
        {project.status === "completed" && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-text-primary">
                  Готовые клипы <span className="text-text-tertiary">({outputs.length})</span>
                </h3>
                {project.mode === "uniquify_source" && (
                  <Button size="sm" variant="primary" onClick={() => router.push("/uniquify")}>
                    → В уникализацию
                  </Button>
                )}
              </div>
              {outputs.length === 0 ? (
                <EmptyState title="Нет выходов" description="Клипы ещё обрабатываются или рендер не дал результатов." />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {outputs.map((o) => (
                    <div key={o.id} className="rounded-xl border border-border overflow-hidden">
                      {o.url ? (
                        <video src={o.url} controls poster={o.thumbnailUrl ?? undefined}
                          className="w-full bg-black" style={{ aspectRatio: aspectCss }} />
                      ) : (
                        <div className="w-full bg-surface-3" style={{ aspectRatio: aspectCss }} />
                      )}
                      <div className="p-2.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text-primary truncate">{o.title}</p>
                          <p className="text-2xs text-text-tertiary">
                            {o.durationSec ? fmtTime(Number(o.durationSec)) : ""}
                            {o.sourceVideoId ? " · в источниках уникализации" : ""}
                          </p>
                        </div>
                        {o.url && (
                          <a href={o.url} download
                            className="shrink-0 text-xs text-brand-400 hover:underline font-medium">
                            Скачать
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Sticky-бар рендера */}
      {showStoryboard && !isWorking && (
        <div className="sticky bottom-0 border-t border-border bg-surface-0/90 backdrop-blur px-6 py-3 flex items-center justify-between gap-4">
          <span className="text-sm text-text-secondary">
            {included.length > 0
              ? <>Выбрано <b className="text-text-primary">{included.length}</b> клип. · ~{fmtTime(totalSec)} видео</>
              : "Выберите хотя бы один клип для рендера"}
          </span>
          <Button variant="primary" onClick={render} loading={busy} disabled={included.length === 0}>
            {project.status === "completed" ? "🎬 Рендерить заново" : "🎬 Рендерить выбранные"}
          </Button>
        </div>
      )}
    </div>
  );
}

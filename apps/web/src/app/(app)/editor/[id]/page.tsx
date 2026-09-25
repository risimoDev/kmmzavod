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
  type EdlSubtitleLine,
  type FishAudioVoice,
} from "@/lib/api";

const SUBTITLE_STYLES = [
  { id: "tiktok", name: "TikTok", cls: "text-warning font-black", badge: "Хит" },
  { id: "mrbeast", name: "MrBeast", cls: "text-cyan-400 font-black", badge: "Вирус" },
  { id: "neon_glow", name: "Neon Glow", cls: "text-fuchsia-400 font-bold", badge: "Стиль" },
  { id: "fire_hype", name: "Fire Hype", cls: "text-orange-400 font-black", badge: "Драйв" },
  { id: "single_word", name: "1-Word", cls: "text-amber-300 font-black", badge: "100% CTR" },
  { id: "cinematic", name: "Cinema", cls: "text-text-primary font-medium" },
  { id: "minimal", name: "Minimal", cls: "text-text-secondary font-light" },
  { id: "default", name: "Классика", cls: "text-brand-400 font-bold" },
  { id: "none", name: "Выкл", cls: "text-text-tertiary line-through" },
];

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

/**
 * Панель правки клипа: плеер с превью видео, границы сегментов (где ИИ порезал) и субтитры
 * (что и когда написано). Сохранение — PATCH; при смене границ сервер сам
 * пересчитывает субтитры из транскрипта источника.
 */
function ClipEditor({
  projectId,
  clip,
  sources,
  onSaved,
  onSplit,
  onDelete,
  onClose,
}: {
  projectId: string;
  clip: EditClip;
  sources: any[];
  onSaved: (updated: EditClip) => void;
  onSplit?: (part1: EditClip, part2: EditClip) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [segments, setSegments] = useState(
    (clip.edl?.segments ?? []).map((s) => ({ src_idx: s.src_idx, start: s.start, end: s.end }))
  );
  const [subs, setSubs] = useState<EdlSubtitleLine[]>(
    (clip.edl?.subtitles ?? []).map((l) => ({ start: l.start, end: l.end, text: l.text }))
  );
  const [activeSegIdx, setActiveSegIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const curSeg = segments[activeSegIdx] || segments[0] || { src_idx: 0, start: 0, end: 5 };
  const activeSource = sources[curSeg.src_idx];
  const videoUrl = activeSource?.url;

  const patchSeg = (i: number, field: "start" | "end" | "src_idx", v: number) =>
    setSegments((prev) => prev.map((s, j) => (j === i ? { ...s, [field]: Math.max(0, v) } : s)));
  const patchSub = (i: number, patch: Partial<EdlSubtitleLine>) =>
    setSubs((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const playSegment = (start: number, end: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = start;
    void videoRef.current.play();
    const handleTime = () => {
      if (videoRef.current && videoRef.current.currentTime >= end) {
        videoRef.current.pause();
        videoRef.current.removeEventListener("timeupdate", handleTime);
      }
    };
    videoRef.current.addEventListener("timeupdate", handleTime);
  };

  const jumpTo = (time: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const setFromPlayer = (field: "start" | "end") => {
    if (!videoRef.current) return;
    const t = Math.round(videoRef.current.currentTime * 10) / 10;
    patchSeg(activeSegIdx, field, t);
  };

  async function save(kind: "segments" | "subtitles") {
    setSaving(true);
    setError(null);
    try {
      const updated = await editorApi.updateClip(projectId, clip.id,
        kind === "segments" ? { segments } : { subtitles: subs });
      onSaved(updated);
      if (kind === "segments" && updated.edl?.subtitles) {
        setSubs(updated.edl.subtitles.map((l) => ({ start: l.start, end: l.end, text: l.text })));
      }
    } catch (e: any) {
      setError(e.message ?? "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  async function handleSplit() {
    if (!videoRef.current) return;
    const t = Math.round(videoRef.current.currentTime * 10) / 10;
    if (t <= (curSeg?.start ?? 0) || t >= (curSeg?.end ?? 0)) {
      alert("Переместите ползунок плеера внутрь границ сегмента для разреза");
      return;
    }
    setSplitting(true);
    try {
      const res = await editorApi.splitClip(projectId, clip.id, t);
      onSplit?.(res.part1, res.part2);
    } catch (e: any) {
      alert(e.message || "Ошибка при разрезании клипа");
    } finally {
      setSplitting(false);
    }
  }

  const numCls = "w-16 bg-surface-2 border border-border rounded px-1.5 py-1 text-xs font-mono text-text-primary";

  return (
    <div className="border-t border-border bg-surface-2/60 p-3 space-y-3.5 animate-fade-in">
      {/* Видеоплеер для визуальной подгонки границ */}
      {videoUrl ? (
        <div className="space-y-2 rounded-lg bg-surface-1 p-2.5 border border-border">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-text-secondary flex items-center gap-1.5">
              <span>🎬 Предпросмотр источника #{curSeg.src_idx + 1}</span>
            </span>
            <span className="font-mono text-brand-400 font-medium">
              {currentTime.toFixed(1)}с / {activeSource?.durationSec ? `${Number(activeSource.durationSec).toFixed(1)}с` : "…"}
            </span>
          </div>
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            onTimeUpdate={() => videoRef.current && setCurrentTime(videoRef.current.currentTime)}
            className="w-full max-h-44 rounded-md bg-black object-contain border border-border/50"
          />
          <div className="flex items-center justify-between flex-wrap gap-1.5 pt-0.5">
            <div className="flex gap-1.5 items-center flex-wrap">
              <Button
                size="xs"
                variant="primary"
                onClick={() => playSegment(curSeg.start, curSeg.end)}
              >
                ▶ Играть сегмент ({curSeg.start}с → {curSeg.end}с)
              </Button>
              <button
                type="button"
                onClick={() => setFromPlayer("start")}
                className="px-2 py-0.5 rounded bg-surface-2 hover:bg-surface-3 text-text-secondary hover:text-text-primary text-2xs font-medium border border-border"
                title="Установить текущую позицию видео как начало сегмента"
              >
                ⏱ В начало ({currentTime.toFixed(1)}с)
              </button>
              <button
                type="button"
                onClick={() => setFromPlayer("end")}
                className="px-2 py-0.5 rounded bg-surface-2 hover:bg-surface-3 text-text-secondary hover:text-text-primary text-2xs font-medium border border-border"
                title="Установить текущую позицию видео как конец сегмента"
              >
                ⏱ В конец ({currentTime.toFixed(1)}с)
              </button>
            </div>
            <Button
              size="xs"
              variant="secondary"
              loading={splitting}
              onClick={handleSplit}
              title="Разрезать клип по текущей позиции плеера"
            >
              ✂ Разрезать здесь ({currentTime.toFixed(1)}с)
            </Button>
          </div>
        </div>
      ) : null}

      {/* Границы сегментов */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-2xs font-semibold text-text-tertiary uppercase">Границы сегментов (сек)</p>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                const last = segments[segments.length - 1];
                const newStart = last ? last.end : 0;
                setSegments((prev) => [...prev, { src_idx: last ? last.src_idx : 0, start: newStart, end: newStart + 5 }]);
              }}
            >
              + сегмент
            </Button>
            <Button size="xs" variant="secondary" loading={saving} onClick={() => save("segments")}>
              Сохранить границы
            </Button>
          </div>
        </div>
        {segments.map((s, i) => (
          <div
            key={i}
            onClick={() => setActiveSegIdx(i)}
            className={cn(
              "flex items-center gap-1.5 text-xs p-1 rounded transition-colors",
              activeSegIdx === i ? "bg-surface-3 ring-1 ring-brand-500/30" : "hover:bg-surface-3/50"
            )}
          >
            <select
              value={s.src_idx}
              onChange={(e) => patchSeg(i, "src_idx", Number(e.target.value))}
              className="bg-surface-2 border border-border rounded px-1 py-1 text-2xs text-text-primary"
            >
              {sources.map((_, sIdx) => (
                <option key={sIdx} value={sIdx}>#{sIdx + 1}</option>
              ))}
            </select>
            <input
              type="number"
              step={0.1}
              min={0}
              value={s.start}
              className={numCls}
              onChange={(e) => patchSeg(i, "start", Number(e.target.value))}
            />
            <span className="text-text-tertiary">→</span>
            <input
              type="number"
              step={0.1}
              min={0}
              value={s.end}
              className={numCls}
              onChange={(e) => patchSeg(i, "end", Number(e.target.value))}
            />
            <span className="text-text-tertiary font-mono">{Math.max(0, s.end - s.start).toFixed(1)}с</span>
            <button
              type="button"
              onClick={() => jumpTo(s.start)}
              className="text-2xs text-brand-400 hover:underline px-1"
              title="Перейти к началу сегмента в плеере"
            >
              перейти
            </button>
            {segments.length > 1 && (
              <button
                className="text-danger hover:underline ml-auto text-xs"
                onClick={() => setSegments((prev) => prev.filter((_, j) => j !== i))}
              >
                убрать
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Субтитры */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-2xs font-semibold text-text-tertiary uppercase">
            Субтитры ({subs.length} фраз)
          </p>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                setSubs((p) => [
                  ...p,
                  {
                    start: p.length ? p[p.length - 1].end : 0,
                    end: (p.length ? p[p.length - 1].end : 0) + 2,
                    text: "",
                  },
                ])
              }
            >
              + строка
            </Button>
            <Button size="xs" variant="secondary" loading={saving} onClick={() => save("subtitles")}>
              Сохранить субтитры
            </Button>
          </div>
        </div>
        {subs.length === 0 && (
          <p className="text-xs text-text-tertiary">
            Нет фраз — речь не распознана. Добавьте строки вручную или проверьте, что в видео есть речь.
          </p>
        )}
        <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
          {subs.map((l, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                type="number"
                step={0.1}
                min={0}
                value={l.start}
                className={numCls}
                onChange={(e) => patchSub(i, { start: Number(e.target.value) })}
              />
              <input
                type="number"
                step={0.1}
                min={0}
                value={l.end}
                className={numCls}
                onChange={(e) => patchSub(i, { end: Number(e.target.value) })}
              />
              <input
                value={l.text}
                placeholder="текст фразы"
                className="flex-1 bg-surface-2 border border-border rounded px-2 py-1 text-xs text-text-primary"
                onChange={(e) => patchSub(i, { text: e.target.value })}
              />
              <button
                className="text-danger text-xs hover:underline"
                onClick={() => setSubs((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <p className="text-3xs text-text-tertiary">
          Отредактированные фразы будут вжжены в видео как есть (пословная подсветка сохранится).
        </p>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center justify-between pt-1 border-t border-border/40">
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="text-danger text-xs hover:underline flex items-center gap-1"
          >
            🗑️ Удалить клип
          </button>
        ) : <div />}
        <Button size="xs" variant="ghost" onClick={onClose}>Свернуть</Button>
      </div>
    </div>
  );
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
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const [previewSourceUrl, setPreviewSourceUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // AI Studio (OpenRouter + Fish Audio)
  const [showAiStudio, setShowAiStudio] = useState(false);
  const [aiTopic, setAiTopic] = useState("");
  const [aiProductInfo, setAiProductInfo] = useState("");
  const [aiStyle, setAiStyle] = useState("hype");
  const [aiSeconds, setAiSeconds] = useState(30);
  const [aiScript, setAiScript] = useState("");
  const [aiHook, setAiHook] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [voices, setVoices] = useState<FishAudioVoice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("e04b4c73046f491c89366fbca39d48dd");
  const [customVoiceId, setCustomVoiceId] = useState("");
  const [voiceSpeed, setVoiceSpeed] = useState(1.0);
  const [synthesizing, setSynthesizing] = useState(false);
  const [voiceoverAudioUrl, setVoiceoverAudioUrl] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [showSafeZones, setShowSafeZones] = useState(false);
  const [fishApiKey, setFishApiKey] = useState("");
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [showKeyConfig, setShowKeyConfig] = useState(false);
  const [geometryNotice, setGeometryNotice] = useState(false);
  const scriptTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setFishApiKey(localStorage.getItem("fish_audio_api_key") || "");
      setOpenRouterApiKey(localStorage.getItem("openrouter_api_key") || "");
    }
  }, []);

  const saveFishApiKey = (key: string) => {
    setFishApiKey(key);
    if (typeof window !== "undefined") {
      if (key.trim()) localStorage.setItem("fish_audio_api_key", key.trim());
      else localStorage.removeItem("fish_audio_api_key");
    }
  };

  const saveOpenRouterApiKey = (key: string) => {
    setOpenRouterApiKey(key);
    if (typeof window !== "undefined") {
      if (key.trim()) localStorage.setItem("openrouter_api_key", key.trim());
      else localStorage.removeItem("openrouter_api_key");
    }
  };

  function insertEmotionTag(tag: string) {
    const el = scriptTextareaRef.current;
    const insertion = `[${tag}] `;
    if (!el) {
      setAiScript((prev) => (prev ? `${prev} ${insertion}` : insertion));
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = el.value;
    const updated = text.substring(0, start) + insertion + text.substring(end);
    setAiScript(updated);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + insertion.length, start + insertion.length);
    }, 10);
  }

  useEffect(() => {
    editorApi.getVoices({ apiKey: fishApiKey || undefined }).then((res) => {
      if (res.voices?.length) {
        setVoices(res.voices);
      }
    }).catch(() => {});
  }, [fishApiKey]);

  useEffect(() => {
    if (project) {
      if (project.name && !aiTopic) {
        setAiTopic(project.name);
      }
      if (project.config) {
        const cfg = project.config as Record<string, any>;
        if (cfg.productInfo && !aiProductInfo) setAiProductInfo(cfg.productInfo);
        if (cfg.generatedScript && !aiScript) setAiScript(cfg.generatedScript);
        if (cfg.scriptHook && !aiHook) setAiHook(cfg.scriptHook);
        const vId = cfg.voiceId || (project as any).voiceId;
        if (vId) {
          setSelectedVoiceId(vId);
          const isPreset = voices.some((v) => v.id === vId);
          if (!isPreset && vId !== "e04b4c73046f491c89366fbca39d48dd") {
            setCustomVoiceId(vId);
          }
        }
        if (cfg.voiceSpeed) setVoiceSpeed(cfg.voiceSpeed);
      }
    }
    // Auto-sync aiSeconds with total included clips duration
    if (project?.clips && project.clips.length > 0) {
      const includedClips = project.clips.filter((c: any) => c.included);
      const totalDur = includedClips.reduce((sum: number, c: any) => sum + (Number(c.durationSec) || 0), 0);
      if (totalDur > 0) {
        setAiSeconds(Math.round(totalDur));
      }
    }
  }, [project, voices]);

  async function handleSelectVoice(vId: string) {
    setSelectedVoiceId(vId);
    setCustomVoiceId("");
    if (id) {
      await editorApi.patchProject(id, { voiceId: vId } as any).catch(() => {});
    }
  }

  async function handleCustomVoiceChange(val: string) {
    setCustomVoiceId(val);
    const effective = val.trim() || selectedVoiceId;
    if (id && val.trim()) {
      await editorApi.patchProject(id, { voiceId: effective } as any).catch(() => {});
    }
  }

  async function handleGenerateScript() {
    const effectiveTopic = aiTopic.trim() || project?.name || "Видеоролик";
    setAiGenerating(true);
    try {
      const res = await editorApi.generateScript(id, {
        topic: effectiveTopic,
        projectName: project?.name,
        productInfo: aiProductInfo.trim() || undefined,
        style: aiStyle,
        targetSeconds: aiSeconds,
        mode: 'generate',
        useSourceTranscript: true,
        apiKey: openRouterApiKey.trim() || undefined,
      });
      setAiScript(res.script);
      setAiHook(res.hook);
    } catch (e: any) {
      alert(e.message || "Ошибка генерации сценария");
    } finally {
      setAiGenerating(false);
    }
  }

  async function handleFitScript() {
    if (!aiScript.trim()) {
      return handleGenerateScript();
    }
    setAiGenerating(true);
    try {
      const res = await editorApi.generateScript(id, {
        topic: aiTopic.trim() || project?.name || "Видеоролик",
        projectName: project?.name,
        productInfo: aiProductInfo.trim() || undefined,
        currentScript: aiScript,
        mode: 'fit',
        style: aiStyle,
        targetSeconds: aiSeconds,
        useSourceTranscript: true,
        apiKey: openRouterApiKey.trim() || undefined,
      });
      setAiScript(res.script);
      if (res.hook) setAiHook(res.hook);
    } catch (e: any) {
      alert(e.message || "Ошибка адаптации текста под хронометраж");
    } finally {
      setAiGenerating(false);
    }
  }

  async function handleGenerateVoice() {
    if (!aiScript.trim()) return;
    setSynthesizing(true);
    setVoiceError(null);
    try {
      const effectiveVoiceId = customVoiceId.trim() || selectedVoiceId;
      const res = await editorApi.generateVoice(id, {
        text: aiScript,
        voiceId: effectiveVoiceId,
        speed: voiceSpeed,
        apiKey: fishApiKey.trim() || undefined,
      });
      setVoiceoverAudioUrl(res.audioUrl);
      await load();
    } catch (e: any) {
      setVoiceError(e.message || "Ошибка генерации голоса Fish Audio");
    } finally {
      setSynthesizing(false);
    }
  }

  async function changeGeometry(geometry: "highlights" | "mix") {
    if (!project) return;
    setProject({ ...project, geometry });
    setGeometryNotice(true);
    await editorApi.patchProject(id, { geometry }).catch(() => {});
  }

  async function changeTargetClipCount(targetClipCount: number) {
    if (!project) return;
    setProject({ ...project, targetClipCount });
    setGeometryNotice(true);
    await editorApi.patchProject(id, { targetClipCount }).catch(() => {});
  }

  async function changeSubtitleStyle(style: string) {
    if (!project) return;
    setProject({ ...project, subtitleStyle: style });
    await editorApi.patchProject(id, { subtitleStyle: style }).catch(() => {});
  }

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

  function mergeClip(updated: EditClip) {
    setProject((p) => p && {
      ...p,
      clips: p.clips.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
    });
  }

  async function handleAddClip() {
    if (!project || project.sources.length === 0) return;
    try {
      const newClip = await editorApi.createClip(id, {
        title: `Новый клип ${project.clips.length + 1}`,
        segments: [{
          src_idx: 0,
          start: 0,
          end: Math.min(30, Number(project.sources[0]?.durationSec ?? 30)),
        }],
      });
      setProject({
        ...project,
        clips: [...project.clips, newClip],
      });
      setEditingClipId(newClip.id);
    } catch (e: any) {
      alert(e.message || "Ошибка создания клипа");
    }
  }

  function handleClipSplit(clipId: string, part1: EditClip, part2: EditClip) {
    if (!project) return;
    const clips: EditClip[] = [];
    for (const c of project.clips) {
      if (c.id === clipId) {
        clips.push(part1, part2);
      } else {
        clips.push(c);
      }
    }
    setProject({ ...project, clips });
    setEditingClipId(null);
  }

  function handleClipDeleted(clipId: string) {
    if (!project) return;
    setProject({
      ...project,
      clips: project.clips.filter((c) => c.id !== clipId),
    });
    setEditingClipId(null);
  }

  const included = useMemo(() => project?.clips.filter((c) => c.included) ?? [], [project]);
  const totalSec = useMemo(() => included.reduce((a, c) => a + clipDuration(c), 0), [included]);
  // Субтитры включены, но ни у одного клипа нет распознанных фраз → Whisper не
  // отработал или в видео нет речи. Показываем точную причину из анализа.
  const noTranscript = useMemo(() =>
    project != null && project.subtitleStyle !== "none" && project.clips.length > 0 &&
    project.clips.every((c) => (c.edl?.subtitles ?? []).length === 0 && !c.transcriptSnippet),
  [project]);
  const transcriptError = useMemo(() =>
    project?.sources.map((s) => s.analysis?.transcript_error).find(Boolean) ?? null,
  [project]);

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

        {/* Панель сборки: Режим (Хайлайты / Микс) и число клипов */}
        <div className="flex items-center justify-between flex-wrap gap-2.5 rounded-xl border border-border bg-surface-1 p-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-2xs font-semibold uppercase text-text-tertiary">Режим сборки:</span>
              <button
                type="button"
                onClick={() => changeGeometry("highlights")}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs transition-all flex items-center gap-1 font-medium",
                  project.geometry === "highlights"
                    ? "bg-brand-500/20 text-brand-400 ring-1 ring-brand-500/40 font-semibold"
                    : "bg-surface-2 text-text-secondary hover:text-text-primary"
                )}
              >
                <span>🎯 Хайлайты (нарезка клипов)</span>
              </button>
              <button
                type="button"
                onClick={() => changeGeometry("mix")}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs transition-all flex items-center gap-1 font-medium",
                  project.geometry === "mix"
                    ? "bg-brand-500/20 text-brand-400 ring-1 ring-brand-500/40 font-semibold"
                    : "bg-surface-2 text-text-secondary hover:text-text-primary"
                )}
              >
                <span>🎛️ Микс (1 ролик)</span>
              </button>
            </div>

            {project.geometry === "highlights" && (
              <div className="flex items-center gap-1.5 pl-2 border-l border-border">
                <span className="text-2xs font-semibold uppercase text-text-tertiary">Клипов:</span>
                {[1, 2, 3, 4, 5, 8, 10].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => changeTargetClipCount(num)}
                    className={cn(
                      "w-6 h-6 rounded flex items-center justify-center text-xs font-mono transition-all",
                      project.targetClipCount === num
                        ? "bg-brand-500 text-white font-bold"
                        : "bg-surface-2 text-text-secondary hover:bg-surface-3"
                    )}
                  >
                    {num}
                  </button>
                ))}
              </div>
            )}
          </div>

          {geometryNotice && (
            <div className="flex items-center gap-2 animate-fade-in">
              <span className="text-2xs text-warning">Параметры изменены.</span>
              <Button size="xs" variant="primary" onClick={analyze} loading={busy || project.status === "analyzing"}>
                🔍 Пересобрать раскадровку
              </Button>
            </div>
          )}
        </div>

        {/* Панель инструментов: AI Студия, Пресеты субтитров, Безопасные зоны */}
        <div className="flex items-center justify-between flex-wrap gap-2.5 rounded-xl border border-border bg-surface-1 p-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-2xs font-semibold uppercase text-text-tertiary mr-1">Стиль субтитров:</span>
            {SUBTITLE_STYLES.map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => changeSubtitleStyle(st.id)}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs transition-all flex items-center gap-1",
                  project.subtitleStyle === st.id
                    ? "bg-brand-500/20 text-brand-400 ring-1 ring-brand-500/40 font-semibold shadow-brand-glow-sm"
                    : "bg-surface-2 text-text-secondary hover:text-text-primary hover:bg-surface-3"
                )}
              >
                <span className={st.cls}>Aa</span>
                <span>{st.name}</span>
                {st.badge && (
                  <span className="text-3xs px-1 rounded bg-brand-500/20 text-brand-300 font-bold">
                    {st.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {project.aspect === "9:16" && (
              <button
                type="button"
                onClick={() => setShowSafeZones(!showSafeZones)}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1",
                  showSafeZones
                    ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40 font-semibold"
                    : "bg-surface-2 text-text-secondary hover:text-text-primary"
                )}
              >
                <span>📱 Safe Zones</span>
                <span className="text-2xs opacity-75">{showSafeZones ? "Вкл" : "Выкл"}</span>
              </button>
            )}

            <Button
              size="sm"
              variant={showAiStudio ? "secondary" : "primary"}
              onClick={() => setShowAiStudio(!showAiStudio)}
              className="gap-1.5"
            >
              <span>✨ AI Студия: Сценарий & Озвучка</span>
            </Button>
          </div>
        </div>

        {/* AI Студия: OpenRouter Free Cascade + Fish Audio s2.1-pro-free */}
        {showAiStudio && (
          <Card className="border-brand-500/40 bg-gradient-to-br from-surface-1 via-surface-2/70 to-surface-1 shadow-elevation-2 animate-fade-in">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-border/60 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">🎙️</span>
                  <div>
                    <h3 className="font-semibold text-text-primary text-base">
                      AI Студия: Генерация сценария и озвучки
                    </h3>
                    <p className="text-xs text-text-secondary">
                      Сценарий через OpenRouter (каскад бесплатных моделей) → Озвучка через Fish Audio (s2.1-pro-free) → точные субтитры по голосу
                    </p>
                  </div>
                </div>
                <Button size="xs" variant="ghost" onClick={() => setShowAiStudio(false)}>
                  ✕ Закрыть
                </Button>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                {/* 1. Тема и стиль сценария */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase text-text-tertiary">
                      1. Сценарий (OpenRouter)
                    </span>
                    <span className="text-3xs font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                      Free Cascade
                    </span>
                  </div>

                  <div>
                    <label className="text-3xs text-text-tertiary mb-1 block">Тема / название ролика:</label>
                    <input
                      value={aiTopic}
                      onChange={(e) => setAiTopic(e.target.value)}
                      placeholder="Название или тема (например: 3 секрета продаж)..."
                      className="w-full bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-3xs text-text-tertiary">Польза / фишки / суть продукта:</label>
                      <span className="text-3xs text-text-tertiary">автосохранение</span>
                    </div>
                    <textarea
                      rows={2}
                      value={aiProductInfo}
                      onChange={(e) => setAiProductInfo(e.target.value)}
                      onBlur={() => {
                        if (id && aiProductInfo.trim()) {
                          editorApi.patchProject(id, { productInfo: aiProductInfo.trim() } as any).catch(() => {});
                        }
                      }}
                      placeholder="Какую проблему решает, фишки, личный опыт, в чем польза для зрителя..."
                      className="w-full bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none leading-relaxed"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { id: "hype", label: "🔥 Вирусный / Интрига" },
                      { id: "educational", label: "💡 Экспертный лайфхак" },
                      { id: "story", label: "📖 Личный опыт / Кейс" },
                      { id: "sales", label: "🎯 Нативная рекомендация" },
                    ].map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => setAiStyle(st.id)}
                        className={cn(
                          "px-2 py-1.5 rounded text-2xs text-left transition-all",
                          aiStyle === st.id
                            ? "bg-brand-500/20 text-brand-400 ring-1 ring-brand-500/40 font-medium"
                            : "bg-surface-3 text-text-secondary hover:text-text-primary"
                        )}
                      >
                        {st.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-text-secondary">Длительность:</span>
                    <span className="font-mono text-brand-400 font-semibold">{aiSeconds} сек</span>
                  </div>
                  <input
                    type="range"
                    min={15}
                    max={60}
                    step={5}
                    value={aiSeconds}
                    onChange={(e) => setAiSeconds(Number(e.target.value))}
                    className="w-full accent-brand-500"
                  />

                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full"
                    loading={aiGenerating}
                    disabled={!aiTopic.trim() && !project?.name}
                    onClick={handleGenerateScript}
                  >
                    ⚡ Сгенерировать сценарий
                  </Button>
                </div>

                {/* 2. Текст сценария (редактируемый) + Эмоции Fish Audio */}
                {/* 2. Текст сценария & Озвучка */}
                <div className="space-y-2">
                  {(() => {
                    const cleanText = aiScript.replace(/\[[a-zA-Z_\s-]+\]/g, '').trim();
                    const scriptWords = cleanText ? cleanText.split(/\s+/).filter(Boolean).length : 0;
                    const estSpeechSec = Math.round(scriptWords / 2.05);
                    const diffSec = estSpeechSec - aiSeconds;
                    const isSynced = Math.abs(diffSec) <= 2;
                    return (
                      <>
                        <div className="flex items-center justify-between text-2xs">
                          <span className="font-semibold uppercase text-text-tertiary">
                            2. Текст для диктора
                          </span>
                          <div className="flex items-center gap-1.5 font-mono">
                            <span className="text-text-secondary">{scriptWords} слов</span>
                            <span className="text-text-tertiary">·</span>
                            <span
                              className={cn(
                                "px-1.5 py-0.5 rounded text-3xs font-semibold",
                                scriptWords === 0
                                  ? "text-text-tertiary bg-surface-2"
                                  : isSynced
                                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                                  : "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                              )}
                              title="Расчётная длительность озвучки относительно хронометража ролика"
                            >
                              ~{estSpeechSec}с / ролик {aiSeconds}с
                              {scriptWords > 0 && !isSynced && ` (${diffSec > 0 ? `+${diffSec}` : diffSec}с)`}
                            </span>
                          </div>
                        </div>

                        {scriptWords > 0 && !isSynced && (
                          <div className="flex items-center justify-between p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-3xs text-amber-300 animate-fade-in">
                            <span>
                              {diffSec < 0
                                ? `⚠️ Текст короче видео на ${Math.abs(diffSec)} сек (в конце останется тишина).`
                                : `⚠️ Текст длиннее видео на ${diffSec} сек (голос может обрезаться).`}
                            </span>
                            <button
                              type="button"
                              disabled={aiGenerating}
                              onClick={handleFitScript}
                              className="underline hover:text-amber-200 font-semibold ml-2 shrink-0 disabled:opacity-50"
                            >
                              {aiGenerating ? "Подгонка..." : `Подогнать под ${aiSeconds}с`}
                            </button>
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {aiHook && (
                    <div className="rounded-md bg-brand-500/10 border border-brand-500/30 p-2 text-2xs text-brand-300">
                      <span className="font-bold">Хук (0-3с): </span>{aiHook}
                    </div>
                  )}

                  {/* Быстрые теги эмоций Fish Audio */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-3xs font-semibold uppercase text-text-tertiary">Эмоции Fish Audio:</span>
                      {aiScript.trim() && (
                        <button
                          type="button"
                          disabled={aiGenerating}
                          onClick={handleFitScript}
                          className="text-3xs font-semibold px-2 py-0.5 rounded bg-brand-500/20 text-brand-300 border border-brand-500/40 hover:bg-brand-500/30 transition-all disabled:opacity-50"
                          title={`Дополнить и улучшить текст ровно под ${aiSeconds} секунд`}
                        >
                          {aiGenerating ? "✨ Подгоняем..." : `✨ Подогнать под ${aiSeconds}с`}
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {[
                        { tag: "excited", label: "🔥 Драйв", title: "Энергично, воодушевленно" },
                        { tag: "confident", label: "💼 Уверенно", title: "Авторитетный эксперт" },
                        { tag: "whispering", label: "🤫 Шёпотом", title: "Интрига, по секрету" },
                        { tag: "laughing", label: "😂 Смех", title: "С лёгким смехом/юмором" },
                        { tag: "surprised", label: "😲 Шок", title: "Удивление, сенсация" },
                        { tag: "gasp", label: "😱 Вздох шока", title: "Резкий вдох от неожиданности" },
                        { tag: "urgent", label: "⚡ Срочно", title: "Призыв к действию / CTA" },
                        { tag: "curious", label: "🧐 Интрига", title: "С любопытством" },
                        { tag: "calm", label: "😌 Спокойно", title: "Размеренно" },
                        { tag: "sigh", label: "😮‍💨 Вздох", title: "Со вздохом" },
                      ].map((em) => (
                        <button
                          key={em.tag}
                          type="button"
                          onClick={() => insertEmotionTag(em.tag)}
                          title={em.title}
                          className="px-1.5 py-0.5 rounded bg-surface-3 hover:bg-surface-4 text-3xs font-medium text-text-secondary hover:text-brand-300 transition-all border border-border"
                        >
                          {em.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <textarea
                    ref={scriptTextareaRef}
                    rows={6}
                    value={aiScript}
                    onChange={(e) => setAiScript(e.target.value)}
                    placeholder="Здесь появится готовый текст для озвучки с тегами [excited], [confident]... Или напишите свой."
                    className="w-full bg-surface-2 border border-border rounded-lg p-2.5 text-xs text-text-primary font-sans leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />

                  <p className="text-3xs text-text-tertiary">
                    Теги в скобках управляют эмоциями диктора и автоматически вырезаются из видео-субтитров.
                  </p>
                </div>

                {/* 3. Голос Fish Audio & Синтез */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase text-text-tertiary">
                      3. Диктор (Fish Audio)
                    </span>
                    <span className="text-3xs font-mono px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-400">
                      s2.1-pro-free
                    </span>
                  </div>

                  {/* Статус API-ключа Fish Audio */}
                  <div className="rounded-lg bg-surface-2/80 p-2.5 border border-border space-y-1.5">
                    <div className="flex items-center justify-between text-2xs">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-text-primary font-medium">Fish Audio API: подключен (.env)</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowKeyConfig(!showKeyConfig)}
                        className="text-text-tertiary hover:text-text-secondary text-3xs underline"
                      >
                        {showKeyConfig ? "скрыть" : (fishApiKey ? "свой ключ (активен)" : "свой ключ")}
                      </button>
                    </div>
                    {showKeyConfig && (
                      <div className="space-y-1 pt-1 border-t border-border/50 animate-fade-in">
                        <input
                          type="password"
                          value={fishApiKey}
                          onChange={(e) => saveFishApiKey(e.target.value)}
                          placeholder="Опционально: свой ключ (по умолчанию берётся из .env сервера)"
                          className="w-full bg-surface-1 border border-border rounded px-2 py-1 text-2xs text-text-primary"
                        />
                        <p className="text-3xs text-text-tertiary">
                          Если оставить пустым — используется системный ключ из .env сервера.
                        </p>
                      </div>
                    )}
                  </div>

                  {voiceError && (
                    <div className="rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-2xs text-danger space-y-1 animate-fade-in">
                      <p className="font-semibold">⚠️ {voiceError}</p>
                    </div>
                  )}

                  <select
                    value={selectedVoiceId}
                    onChange={(e) => handleSelectVoice(e.target.value)}
                    className="w-full bg-surface-2 border border-border rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} ({v.gender === "female" ? "жен." : "муж."})
                      </option>
                    ))}
                  </select>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-3xs text-text-tertiary">
                      <span>Или свой Voice ID:</span>
                      {customVoiceId.trim() && <span className="text-emerald-400 font-medium">✓ сохранен в БД</span>}
                    </div>
                    <input
                      value={customVoiceId}
                      onChange={(e) => handleCustomVoiceChange(e.target.value)}
                      placeholder="Опционально: ID голоса из fish.audio (сохраняется в проект)"
                      className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-2xs text-text-primary placeholder:text-text-tertiary"
                    />
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-text-secondary">Скорость речи:</span>
                    <span className="font-mono text-brand-400 font-semibold">{voiceSpeed.toFixed(1)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.8}
                    max={1.3}
                    step={0.05}
                    value={voiceSpeed}
                    onChange={(e) => setVoiceSpeed(Number(e.target.value))}
                    className="w-full accent-brand-500"
                  />

                  <Button
                    size="sm"
                    variant="primary"
                    className="w-full"
                    loading={synthesizing}
                    disabled={!aiScript.trim()}
                    onClick={handleGenerateVoice}
                  >
                    🎙️ Озвучить через Fish Audio
                  </Button>

                  {voiceoverAudioUrl && (
                    <div className="space-y-1 pt-1 animate-fade-in">
                      <p className="text-3xs text-emerald-400 font-medium">✓ Озвучка готова и привязана:</p>
                      <audio controls src={voiceoverAudioUrl} className="w-full h-8 rounded" />
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

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
              <div className="space-y-2">
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
                      {s.url && (
                        <button
                          type="button"
                          onClick={() => setPreviewSourceUrl(previewSourceUrl === s.url ? null : s.url!)}
                          className="text-2xs text-brand-400 hover:underline px-1 ml-1"
                        >
                          {previewSourceUrl === s.url ? "закрыть" : "▶ просмотр"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {previewSourceUrl && (
                  <div className="p-2.5 rounded-lg bg-surface-2 border border-border space-y-1.5 animate-fade-in max-w-lg">
                    <div className="flex items-center justify-between text-xs text-text-secondary">
                      <span className="font-semibold">🎬 Просмотр исходного видео</span>
                      <button onClick={() => setPreviewSourceUrl(null)} className="text-text-tertiary hover:text-text-primary text-xs">✕</button>
                    </div>
                    <video src={previewSourceUrl} controls className="max-h-56 rounded bg-black w-full object-contain" />
                  </div>
                )}
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
                <div className="flex gap-1.5 items-center">
                  <Button variant="secondary" size="xs" onClick={handleAddClip}>+ Клип</Button>
                  <Button variant="ghost" size="xs" onClick={() => setAll(true)}>Все</Button>
                  <Button variant="ghost" size="xs" onClick={() => setAll(false)}>Ничего</Button>
                </div>
              </div>

              {noTranscript && (
                <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning space-y-0.5">
                  <p>Выбраны субтитры, но речь не распознана ни в одном клипе.</p>
                  {transcriptError ? (
                    <p className="font-mono break-all">Причина: {transcriptError}</p>
                  ) : (
                    <p>Либо в видео нет голоса, либо Whisper недоступен в editor-сервисе
                      (см. GET /health editor'а).</p>
                  )}
                  <p>Субтитры можно вписать вручную через «✎ правка» на клипе.</p>
                </div>
              )}

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
                        {/* Safe Zones Overlay */}
                        {showSafeZones && project.aspect === "9:16" && (
                          <div className="absolute inset-0 pointer-events-none z-10 select-none">
                            <div className="absolute top-0 inset-x-0 h-[12%] bg-red-500/15 border-b border-red-500/40 flex items-center justify-center">
                              <span className="text-3xs text-red-200 font-mono">Интерфейс (верх)</span>
                            </div>
                            <div className="absolute top-[12%] bottom-[20%] right-0 w-[16%] bg-amber-500/15 border-l border-amber-500/40 flex items-center justify-center">
                              <span className="text-3xs text-amber-200 font-mono -rotate-90">Кнопки</span>
                            </div>
                            <div className="absolute bottom-0 inset-x-0 h-[20%] bg-red-500/15 border-t border-red-500/40 flex items-center justify-center">
                              <span className="text-3xs text-red-200 font-mono">Описание / музыка</span>
                            </div>
                            <div className="absolute top-[12%] left-0 right-[16%] bottom-[20%] border border-dashed border-emerald-400/60" />
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
                          <span className="font-mono">
                            score {Number(c.score).toFixed(2)}
                            {(c.edl?.subtitles?.length ?? 0) > 0 && (
                              <> · {c.edl!.subtitles!.length} фраз</>
                            )}
                          </span>
                          <span className="flex gap-0.5 items-center">
                            <button
                              onClick={() => setEditingClipId(editingClipId === c.id ? null : c.id)}
                              className={cn(
                                "px-1.5 py-0.5 rounded transition-colors",
                                editingClipId === c.id
                                  ? "bg-brand-500/15 text-brand-400"
                                  : "hover:bg-surface-2"
                              )}>
                              ✎ правка
                            </button>
                            <button
                              type="button"
                              title="Удалить клип"
                              onClick={() => {
                                if (confirm(`Удалить клип "${c.title}"?`)) {
                                  editorApi.deleteClip(id, c.id).then(() => handleClipDeleted(c.id)).catch((err) => alert(err.message));
                                }
                              }}
                              className="px-1 py-0.5 rounded text-danger/70 hover:text-danger hover:bg-danger/10 text-xs"
                            >
                              ✕
                            </button>
                            <button onClick={() => moveClip(idx, -1)} disabled={idx === 0}
                              className="px-1.5 py-0.5 rounded hover:bg-surface-2 disabled:opacity-30">←</button>
                            <button onClick={() => moveClip(idx, 1)} disabled={idx === project.clips.length - 1}
                              className="px-1.5 py-0.5 rounded hover:bg-surface-2 disabled:opacity-30">→</button>
                          </span>
                        </div>
                      </div>

                      {editingClipId === c.id && (
                        <ClipEditor
                          projectId={id}
                          clip={c}
                          sources={project.sources}
                          onSaved={mergeClip}
                          onSplit={(part1, part2) => handleClipSplit(c.id, part1, part2)}
                          onDelete={() => {
                            if (confirm(`Удалить клип "${c.title}"?`)) {
                              editorApi.deleteClip(id, c.id).then(() => handleClipDeleted(c.id)).catch((err) => alert(err.message));
                            }
                          }}
                          onClose={() => setEditingClipId(null)}
                        />
                      )}
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
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => router.push("/projects")}>
                    📁 К проектам
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => router.push("/uniquify")}>
                    ⚡ В уникализацию
                  </Button>
                </div>
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
                      <div className="p-2.5 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-text-primary truncate">{o.title}</p>
                            <p className="text-2xs text-text-tertiary">
                              {o.durationSec ? fmtTime(Number(o.durationSec)) : ""}
                              {o.sourceVideoId ? " · сохранён в проекте" : ""}
                            </p>
                          </div>
                          {o.url && (
                            <a href={o.url} download
                              className="shrink-0 text-xs text-brand-400 hover:underline font-medium">
                              Скачать
                            </a>
                          )}
                        </div>
                        {o.sourceVideoId && (
                          <Button
                            size="xs"
                            variant="secondary"
                            className="w-full text-2xs"
                            onClick={() => {
                              const wsId = (project.config as any)?.workspaceProjectId;
                              const pQuery = wsId ? `&projectId=${wsId}` : "";
                              router.push(`/uniquify?sourceVideoId=${o.sourceVideoId}${pQuery}`);
                            }}
                          >
                            ⚡ Уникализировать этот ролик
                          </Button>
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

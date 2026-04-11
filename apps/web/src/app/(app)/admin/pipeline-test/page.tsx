"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Button,
  Card,
  CardContent,
  Input,
  Textarea,
  Badge,
  Progress,
  LoadingSpinner,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { adminApi } from "@/lib/admin-api";
import { productsApi, videosApi, type Product } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type LayoutTemplate = {
  name: string;
  description: string;
  segments: Array<{ layout: string; weight: number; bg_type: string }>;
};

type BgAsset = {
  storage_key: string;
  url: string;
  type: "image" | "video";
  name?: string;
};

type Step = "input" | "media" | "compose" | "result";

// ── Consts ────────────────────────────────────────────────────────────────────

// ── Voice metadata ────────────────────────────────────────────────────────
const VOICES = [
  { id: "70856236390f4d0392d00187143d3900", label: "Лариса (RU, Ж)", gender: "female" as const },
  { id: "ba1544b5eae84eae9cb92598f078b6b0", label: "Олег (RU, М)", gender: "male" as const },
  { id: "bc69c9589d6747028dc5ec4aec2b43c3", label: "Дарья (RU, Ж)", gender: "female" as const },
  { id: "81bb7c1a521442f6b812b2294a29acc1", label: "Дмитрий (RU, М)", gender: "male" as const },
] as const;

type HeyGenVoice = {
  voice_id: string;
  name: string;
  gender: string | null;
  language: string | null;
  preview_audio_url: string | null;
};

const SUB_STYLES = [
  { value: "tiktok", label: "TikTok Bold" },
  { value: "cinematic", label: "Кинематограф" },
  { value: "minimal", label: "Минимальный" },
  { value: "default", label: "Стандартный" },
] as const;

const LAYOUT_LABELS: Record<string, string> = {
  fullscreen: "На весь экран",
  pip_bl: "PIP слева внизу",
  pip_br: "PIP справа внизу",
  pip_tl: "PIP слева вверху",
  pip_tr: "PIP справа вверху",
  voiceover: "Только голос",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PipelineTestPage() {
  const [step, setStep] = useState<Step>("input");

  // Step 1: input
  const [productName, setProductName] = useState("");
  const [productDesc, setProductDesc] = useState("");
  const [features, setFeatures] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [brandVoice, setBrandVoice] = useState("professional");
  const [prompt, setPrompt] = useState("");
  const [language, setLanguage] = useState("ru");
  const [imageKeys, setImageKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Product picker
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);

  // Avatar & voice
  const [avatarId, setAvatarId] = useState("Anna_public_20240108");
  const [voiceId, setVoiceId] = useState("70856236390f4d0392d00187143d3900");
  const [avatars, setAvatars] = useState<Array<{ avatar_id: string; avatar_name: string; preview_image_url: string | null }>>([]);
  const [targetDuration, setTargetDuration] = useState(30);
  const [zoomedAvatar, setZoomedAvatar] = useState<string | null>(null);
  const [avatarPage, setAvatarPage] = useState(0);

  // Voice selection
  const [heygenVoices, setHeygenVoices] = useState<HeyGenVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voiceGenderFilter, setVoiceGenderFilter] = useState<"all" | "male" | "female">("all");
  const [voiceLangFilter, setVoiceLangFilter] = useState("Russian");
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voicePage, setVoicePage] = useState(0);
  const [voiceNextToken, setVoiceNextToken] = useState<string | null>(null);
  const [voiceHasMore, setVoiceHasMore] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);

  // Layout template
  const [layoutTemplates, setLayoutTemplates] = useState<Record<string, LayoutTemplate>>({});
  const [selectedTemplate, setSelectedTemplate] = useState("presenter");

  // HeyGen existing video shortcut
  const [heygenExistingId, setHeygenExistingId] = useState("");

  // Step 2: media
  const [title, setTitle] = useState("");
  const [fullScript, setFullScript] = useState("");
  const [bRollPrompts, setBRollPrompts] = useState<Array<{ type: string; prompt: string }>>([]);
  // Single avatar generation
  const [avatarGen, setAvatarGen] = useState<{ status: "idle" | "generating" | "done" | "error"; startedAt?: number; elapsed?: number; error?: string }>({ status: "idle" });
  const [avatarKey, setAvatarKey] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [avatarDuration, setAvatarDuration] = useState(0);
  // Background assets
  const [backgrounds, setBackgrounds] = useState<BgAsset[]>([]);
  const [uploadingBg, setUploadingBg] = useState(false);

  // Step 3: compose
  const [withSubtitles, setWithSubtitles] = useState(true);
  const [subtitleStyle, setSubtitleStyle] = useState<"tiktok" | "cinematic" | "minimal" | "default">("tiktok");
  const [composing, setComposing] = useState(false);
  // BGM
  const [bgmKey, setBgmKey] = useState("");
  const [bgmName, setBgmName] = useState("");
  const [bgmEnabled, setBgmEnabled] = useState(false);
  const [uploadingBgm, setUploadingBgm] = useState(false);
  const [bgmVolume, setBgmVolume] = useState(0.12);

  // Step 4: result
  const [result, setResult] = useState<{
    test_id: string;
    layout_template: string;
    compose_result: { output_key: string; duration_sec: number; file_size_bytes: number; width: number; height: number; scene_count: number };
    output_url: string;
    elapsed_ms: number;
  } | null>(null);

  // Test history
  const [testRuns, setTestRuns] = useState<Array<{
    id: string;
    productName: string;
    title: string | null;
    layoutTemplate: string;
    targetDuration: number;
    outputUrl: string | null;
    durationSec: number | null;
    status: string;
    createdAt: string;
  }>>([]);
  const [testRunsTotal, setTestRunsTotal] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);

  // Refs
  const bgFileRef = useRef<HTMLInputElement>(null);
  const bgmFileRef = useRef<HTMLInputElement>(null);
  const avatarAutoStarted = useRef(false);

  // ── Load avatars & layout templates ──────────────────────────────────────
  useEffect(() => {
    videosApi.avatars()
      .then((res) => setAvatars(res.avatars))
      .catch((err) => console.error('[pipeline-test] Ошибка загрузки аватаров:', err));
    adminApi.pipelineTestLayoutTemplates()
      .then(setLayoutTemplates)
      .catch((err) => console.error('[pipeline-test] Ошибка загрузки шаблонов:', err));
  }, []);

  // ── Load HeyGen voices ─────────────────────────────────────────────────
  const fetchVoices = useCallback(async (lang: string, gender?: string) => {
    setVoicesLoading(true);
    try {
      const params: Record<string, string> = { language: lang };
      if (gender && gender !== "all") params.gender = gender;
      const res = await videosApi.voices(params as any);
      setHeygenVoices(res.data);
      setVoiceHasMore(false);
      setVoiceNextToken(null);
    } catch (err) {
      console.error('[pipeline-test] Ошибка загрузки голосов:', err);
    }
    setVoicesLoading(false);
  }, []);

  useEffect(() => {
    fetchVoices(voiceLangFilter, voiceGenderFilter === "all" ? undefined : voiceGenderFilter);
    setVoicePage(0);
  }, [voiceLangFilter, voiceGenderFilter, fetchVoices]);

  const loadMoreVoices = () => {
    // v2 API возвращает все голоса за один запрос, пагинация не нужна
  };

  const playVoicePreview = (voice: HeyGenVoice) => {
    if (voiceAudioRef.current) {
      voiceAudioRef.current.pause();
      voiceAudioRef.current = null;
    }
    if (playingVoiceId === voice.voice_id) {
      setPlayingVoiceId(null);
      return;
    }
    if (!voice.preview_audio_url) return;
    const audio = new Audio(voice.preview_audio_url);
    audio.onended = () => setPlayingVoiceId(null);
    audio.onerror = () => setPlayingVoiceId(null);
    audio.play().catch(() => setPlayingVoiceId(null));
    voiceAudioRef.current = audio;
    setPlayingVoiceId(voice.voice_id);
  };

  // ── Load products for picker ─────────────────────────────────────────────
  const loadProducts = async () => {
    setProductsLoading(true);
    try {
      const resp = await productsApi.list({ limit: 100 });
      setProducts(resp.data);
    } catch { /* ignore */ }
    setProductsLoading(false);
    setShowProductPicker(true);
  };

  const selectProduct = (p: Product) => {
    setProductName(p.name);
    setProductDesc(p.description ?? "");
    setFeatures(p.features.join(", "));
    setTargetAudience(p.targetAudience ?? "");
    setBrandVoice(p.brandVoice ?? "professional");
    setImageKeys(p.images ?? []);
    setShowProductPicker(false);
  };

  // ── Test history ─────────────────────────────────────────────────────────
  const loadTestRuns = async () => {
    setHistoryLoading(true);
    try {
      const resp = await adminApi.pipelineTestListRuns(20, 0);
      setTestRuns(resp.data);
      setTestRunsTotal(resp.total);
    } catch { /* ignore */ }
    setHistoryLoading(false);
  };

  const loadTestRun = async (id: string) => {
    setLoadingRunId(id);
    try {
      const run = await adminApi.pipelineTestLoadRun(id);
      const p = run.params ?? {};
      setProductName(run.productName);
      setProductDesc(p.productDesc ?? "");
      setFeatures(p.features ?? "");
      setTargetAudience(p.targetAudience ?? "");
      setBrandVoice(p.brandVoice ?? "professional");
      setPrompt(run.prompt);
      setLanguage(run.language);
      setImageKeys(p.imageKeys ?? []);
      setAvatarId(run.avatarId);
      setVoiceId(run.voiceId);
      setTargetDuration(run.targetDuration);
      setSelectedTemplate(run.layoutTemplate);
      setTitle(run.title ?? "");
      setFullScript(run.fullScript ?? "");
      setBRollPrompts(p.bRollPrompts ?? []);
      setSubtitleStyle(run.subtitleStyle as any ?? "tiktok");
      setWithSubtitles(p.withSubtitles ?? true);
      setBgmKey(p.bgmKey ?? "");
      setBgmName(p.bgmName ?? "");
      setBgmEnabled(p.bgmEnabled ?? false);
      setBgmVolume(p.bgmVolume ?? 0.12);
      // Restore avatar
      if (p.avatarKey) {
        setAvatarKey(p.avatarKey);
        setAvatarUrl(p.avatarUrl ?? "");
        setAvatarDuration(p.avatarDuration ?? 0);
        setAvatarGen({ status: "done", elapsed: 0 });
        avatarAutoStarted.current = true;
      } else {
        setAvatarKey("");
        setAvatarUrl("");
        setAvatarGen({ status: "idle" });
        avatarAutoStarted.current = false;
      }
      // Restore backgrounds
      setBackgrounds(p.backgrounds ?? []);
      setResult(null);
      setShowHistory(false);
      setStep("compose");
    } catch (err: any) {
      setError(err.message ?? "Ошибка загрузки теста");
    }
    setLoadingRunId(null);
  };

  const saveTestRun = async (composeResult: typeof result) => {
    if (!composeResult) return;
    try {
      await adminApi.pipelineTestSaveRun({
        productName,
        prompt,
        language,
        avatarId,
        voiceId,
        layoutTemplate: selectedTemplate,
        targetDuration,
        subtitleStyle,
        title,
        fullScript,
        outputUrl: composeResult.output_url,
        outputKey: composeResult.compose_result.output_key,
        durationSec: composeResult.compose_result.duration_sec,
        fileSizeBytes: composeResult.compose_result.file_size_bytes,
        elapsedMs: composeResult.elapsed_ms,
        params: {
          productDesc, features, targetAudience, brandVoice,
          imageKeys, bRollPrompts,
          avatarKey, avatarUrl, avatarDuration,
          backgrounds,
          withSubtitles, bgmKey, bgmName, bgmEnabled, bgmVolume,
        },
      });
    } catch { /* non-critical */ }
  };

  // ── Step 1: Generate layout script ───────────────────────────────────────
  const handleGenerateScript = async () => {
    if (!productName.trim() || !prompt.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const selectedVoiceMeta = VOICES.find((v) => v.id === voiceId);
      const heygenVoiceMeta = heygenVoices.find((v) => v.voice_id === voiceId);
      const detectedGender = heygenVoiceMeta?.gender ?? selectedVoiceMeta?.gender ?? "female";
      const resp = await adminApi.pipelineTestGenerateScriptLayout({
        productName,
        productDescription: productDesc || undefined,
        features: features.split(",").map((f) => f.trim()).filter(Boolean),
        targetAudience: targetAudience || undefined,
        brandVoice: brandVoice || undefined,
        prompt,
        language,
        imageKeys,
        targetDuration,
        gender: detectedGender as "male" | "female",
      });

      setTitle(resp.title);
      setFullScript(resp.full_script);
      setBRollPrompts(resp.b_roll_prompts ?? []);
      // Reset media state
      setAvatarGen({ status: "idle" });
      setAvatarKey("");
      setAvatarUrl("");
      setAvatarDuration(0);
      setBackgrounds([]);
      avatarAutoStarted.current = false;
      setStep("media");
    } catch (err: any) {
      setError(err.message ?? "Ошибка генерации скрипта");
    }
    setLoading(false);
  };

  // ── Generate ONE avatar (black background) — async start + client-side poll ──
  const heygenVideoIdRef = useRef("");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
  }, []);

  const startPolling = useCallback((videoId: string, startedAt: number) => {
    stopPolling();
    heygenVideoIdRef.current = videoId;
    pollTimerRef.current = setInterval(async () => {
      try {
        const res = await adminApi.pipelineTestAvatarStatus(videoId);
        if (res.status === "completed" && res.url) {
          stopPolling();
          setAvatarKey(res.key ?? "");
          setAvatarUrl(res.url);
          setAvatarDuration(res.duration_sec ?? 0);
          setAvatarGen({ status: "done", elapsed: Date.now() - startedAt });
        } else if (res.status === "failed") {
          stopPolling();
          setAvatarGen({ status: "error", error: res.error ?? "HeyGen: ошибка рендера", elapsed: Date.now() - startedAt });
        }
        // else still processing — keep polling
      } catch {
        // network hiccup — keep polling, don't fail
      }
    }, 10_000);
  }, [stopPolling]);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  const generateAvatar = useCallback(async () => {
    if (!fullScript.trim()) return;
    const now = Date.now();
    setAvatarGen({ status: "generating", startedAt: now, elapsed: 0 });

    try {
      const resp = await adminApi.pipelineTestStartAvatar({
        script: fullScript,
        avatar_id: avatarId,
        voice_id: voiceId,
        bg_color: "#00FF00",
        target_duration: targetDuration,
      });
      startPolling(resp.heygen_video_id, now);
    } catch (err: any) {
      setAvatarGen({ status: "error", error: err.message ?? "Ошибка", elapsed: Date.now() - now });
    }
  }, [fullScript, avatarId, voiceId, targetDuration, startPolling]);

  // Manual HeyGen video ID — poll existing video
  const [manualVideoId, setManualVideoId] = useState("");
  const pollManualVideoId = useCallback(async (overrideId?: string) => {
    const vid = (overrideId ?? manualVideoId).trim();
    if (!vid) return;
    const now = Date.now();
    setAvatarGen({ status: "generating", startedAt: now, elapsed: 0 });
    startPolling(vid, now);
  }, [manualVideoId, startPolling]);

  // Auto-start avatar generation when entering media step (skip if avatar already exists)
  useEffect(() => {
    if (step !== "media" || avatarAutoStarted.current || !fullScript.trim() || avatarKey) return;
    avatarAutoStarted.current = true;
    generateAvatar();
  }, [step, fullScript, generateAvatar, avatarKey]);

  // Reset auto-start when going back
  useEffect(() => {
    if (step === "input") avatarAutoStarted.current = false;
  }, [step]);

  // Timer for generation progress
  useEffect(() => {
    if (avatarGen.status !== "generating") return;
    const timer = setInterval(() => {
      setAvatarGen((prev) => (prev.status === "generating" && prev.startedAt
        ? { ...prev, elapsed: Date.now() - prev.startedAt }
        : prev
      ));
    }, 1000);
    return () => clearInterval(timer);
  }, [avatarGen.status]);

  // ── Upload background ────────────────────────────────────────────────────
  const handleBgUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingBg(true);
    try {
      const resp = await adminApi.pipelineTestUploadScene(file);
      const isVideo = file.type.startsWith("video/");
      setBackgrounds((prev) => [...prev, {
        storage_key: resp.key,
        url: resp.url,
        type: isVideo ? "video" : "image",
        name: file.name,
      }]);
    } catch (err: any) {
      setError(err.message ?? "Ошибка загрузки фона");
    }
    setUploadingBg(false);
    if (bgFileRef.current) bgFileRef.current.value = "";
  };

  const removeBg = (idx: number) => {
    setBackgrounds((prev) => prev.filter((_, i) => i !== idx));
  };

  // ── BGM upload ─────────────────────────────────────────────────────────
  const handleBgmUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingBgm(true);
    try {
      const resp = await adminApi.pipelineTestUploadScene(file);
      setBgmKey(resp.key);
      setBgmName(file.name);
      setBgmEnabled(true);
    } catch (err: any) {
      setError(err.message ?? "Ошибка загрузки музыки");
    }
    setUploadingBgm(false);
    if (bgmFileRef.current) bgmFileRef.current.value = "";
  };

  // ── Step 3: Compose layout ───────────────────────────────────────────────
  const canCompose = avatarKey && backgrounds.length >= 1;

  const handleCompose = async () => {
    setComposing(true);
    setError(null);

    try {
      const resp = await adminApi.pipelineTestComposeLayout({
        avatar_storage_key: avatarKey,
        backgrounds: backgrounds.map((b) => ({ storage_key: b.storage_key, type: b.type })),
        layout_template: selectedTemplate,
        with_subtitles: withSubtitles,
        subtitle_style: subtitleStyle,
        full_script: withSubtitles ? fullScript : undefined,
        audio_track: bgmEnabled && bgmKey ? { storage_key: bgmKey, volume: bgmVolume } : undefined,
      });
      setResult(resp);
      setStep("result");
      // Save to history (fire & forget)
      saveTestRun(resp);
    } catch (err: any) {
      setError(err.message ?? "Ошибка монтажа");
    }
    setComposing(false);
  };

  // ── Helper ────────────────────────────────────────────────────────────────
  const fmtTime = (ms?: number) => {
    if (!ms) return "0:00";
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const currentTempl = layoutTemplates[selectedTemplate];

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <input ref={bgFileRef} type="file" accept="image/*,video/*" className="hidden" onChange={handleBgUpload} />
      <input ref={bgmFileRef} type="file" accept="audio/*" className="hidden" onChange={handleBgmUpload} />

      {/* Header with history button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          {(["input", "media", "compose", "result"] as const).map((s, i) => {
            const labels = ["1. Продукт и промпт", "2. Аватар и фоны", "3. Монтаж", "4. Результат"];
            const active = s === step;
            const done =
              (s === "input" && step !== "input") ||
              (s === "media" && (step === "compose" || step === "result")) ||
              (s === "compose" && step === "result");
            return (
              <span key={s} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-text-tertiary">→</span>}
                <span
                  className={cn(
                    "px-2.5 py-1 rounded-full text-xs font-medium transition-colors",
                    active && "bg-brand-500/20 text-brand-400",
                    done && "bg-green-500/20 text-green-400",
                    !active && !done && "bg-surface-2 text-text-tertiary"
                  )}
                >
                  {labels[i]}
                </span>
              </span>
            );
          })}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { setShowHistory(!showHistory); if (!showHistory) loadTestRuns(); }}
        >
          {showHistory ? "Скрыть историю" : "История тестов"}
        </Button>
      </div>

      {/* Test history panel */}
      {showHistory && (
        <Card>
          <CardContent className="pt-5 pb-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">Предыдущие тесты</h3>
              <span className="text-xs text-text-tertiary">{testRunsTotal} всего</span>
            </div>
            {historyLoading ? (
              <div className="flex justify-center py-4"><LoadingSpinner size={20} /></div>
            ) : testRuns.length === 0 ? (
              <p className="text-xs text-text-tertiary text-center py-4">Нет сохранённых тестов</p>
            ) : (
              <div className="space-y-2">
                {testRuns.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => loadTestRun(run.id)}
                    disabled={loadingRunId === run.id}
                    className="w-full text-left rounded-lg border border-border bg-surface-1 p-3 hover:border-brand-500/40 transition-all group disabled:opacity-60"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary group-hover:text-brand-400 truncate">
                          {run.title || run.productName}
                        </p>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[10px] text-text-tertiary">{run.productName}</span>
                          <span className="text-[10px] text-text-tertiary">{run.targetDuration}с</span>
                          <span className="text-[10px] text-text-tertiary">
                            {new Date(run.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {run.durationSec && (
                          <Badge variant="outline" className="text-[10px]">{run.durationSec.toFixed(1)}с</Badge>
                        )}
                        <Badge variant={run.status === "completed" ? "success" : "danger"} dot className="text-[10px]">
                          {run.status === "completed" ? "OK" : "Ошибка"}
                        </Badge>
                        {loadingRunId === run.id && <LoadingSpinner size={14} />}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-3 text-xs opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* ──────── Step 1: Product & Prompt ──────────────────────── */}
      {step === "input" && (
        <Card>
          <CardContent className="pt-6 pb-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text-primary">Продукт и задание</h2>
              <Button variant="secondary" size="sm" onClick={loadProducts} disabled={productsLoading}>
                {productsLoading ? <LoadingSpinner size={14} /> : null}
                Выбрать из каталога
              </Button>
            </div>

            {/* Product picker */}
            {showProductPicker && (
              <div className="border border-border rounded-xl bg-surface-1 p-4 space-y-3 max-h-64 overflow-y-auto">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text-secondary">Выберите продукт</span>
                  <Button variant="ghost" size="sm" onClick={() => setShowProductPicker(false)}>✕</Button>
                </div>
                {products.length === 0 ? (
                  <p className="text-sm text-text-tertiary">Нет сохранённых продуктов</p>
                ) : (
                  <div className="space-y-2">
                    {products.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => selectProduct(p)}
                        className="w-full text-left p-3 rounded-lg bg-surface-2 hover:bg-surface-3 transition-colors"
                      >
                        <span className="text-sm font-medium text-text-primary">{p.name}</span>
                        {p.category && <span className="ml-2 text-xs text-text-tertiary">· {p.category}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-secondary">Название продукта *</label>
                <Input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="Крем для лица NovaSkin" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-secondary">Тон бренда</label>
                <select className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary" value={brandVoice} onChange={(e) => setBrandVoice(e.target.value)}>
                  <option value="professional">Профессиональный</option>
                  <option value="friendly">Дружелюбный</option>
                  <option value="expert">Экспертный</option>
                  <option value="casual">Неформальный</option>
                  <option value="luxury">Премиальный</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-secondary">Описание продукта</label>
              <Textarea value={productDesc} onChange={(e) => setProductDesc(e.target.value)} placeholder="Увлажняющий крем с гиалуроновой кислотой..." rows={2} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-secondary">Характеристики (через запятую)</label>
                <Input value={features} onChange={(e) => setFeatures(e.target.value)} placeholder="Гиалуроновая кислота, SPF 30" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-secondary">Целевая аудитория</label>
                <Input value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} placeholder="Женщины 25-45" />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-secondary">Задание для AI (промпт) *</label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Создай вирусное TikTok видео для продвижения крема..."
                rows={3}
              />
            </div>

            {/* Layout template selector */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary">Шаблон монтажа</label>
              <div className="grid grid-cols-3 gap-3">
                {Object.entries(layoutTemplates).map(([key, tmpl]) => (
                  <button
                    key={key}
                    onClick={() => setSelectedTemplate(key)}
                    className={cn(
                      "text-left p-3 rounded-xl border transition-all",
                      selectedTemplate === key
                        ? "border-brand-500 bg-brand-500/10 ring-1 ring-brand-500/30"
                        : "border-border bg-surface-1 hover:bg-surface-2"
                    )}
                  >
                    <p className={cn("text-sm font-semibold", selectedTemplate === key ? "text-brand-400" : "text-text-primary")}>{tmpl.name}</p>
                    <p className="text-xs text-text-tertiary mt-0.5">{tmpl.description}</p>
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {tmpl.segments.map((seg, i) => (
                        <span key={i} className={cn(
                          "text-[10px] px-1.5 py-0.5 rounded",
                          seg.layout === "fullscreen" ? "bg-purple-500/20 text-purple-400" :
                          seg.layout === "voiceover" ? "bg-yellow-500/20 text-yellow-400" :
                          "bg-blue-500/20 text-blue-400"
                        )}>
                          {LAYOUT_LABELS[seg.layout] ?? seg.layout}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-secondary">Язык</label>
                <select className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  <option value="ru">Русский</option>
                  <option value="en">English</option>
                  <option value="de">Deutsch</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-secondary">Голос</label>
                <span className="block text-[10px] text-text-tertiary truncate">
                  {heygenVoices.find((v) => v.voice_id === voiceId)?.name ??
                   VOICES.find((v) => v.id === voiceId)?.label ?? voiceId.slice(0, 12) + "…"}
                </span>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-secondary">Длительность</label>
                <div className="flex gap-1.5">
                  {[30, 45, 60].map((d) => (
                    <button
                      key={d}
                      onClick={() => setTargetDuration(d)}
                      className={cn(
                        "flex-1 rounded-lg border px-2 py-2 text-xs font-medium transition-all",
                        targetDuration === d
                          ? "border-brand-500 bg-brand-500/10 text-brand-400"
                          : "border-border bg-surface-1 text-text-tertiary hover:border-brand-500/40"
                      )}
                    >
                      {d}с
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Voice selection with HeyGen preview */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary">Выбор голоса</label>
              <div className="flex items-center gap-2 mb-2">
                <select
                  className="rounded-lg border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                  value={voiceLangFilter}
                  onChange={(e) => { setVoiceLangFilter(e.target.value); setVoicePage(0); }}
                >
                  <option value="Russian">Русский</option>
                  <option value="Multilingual">Multilingual</option>
                  <option value="English">English</option>
                  <option value="Spanish">Spanish</option>
                  <option value="German">German</option>
                  <option value="French">French</option>
                  <option value="Chinese">Chinese</option>
                </select>
                <div className="flex rounded-lg border border-border overflow-hidden">
                  {(["all", "female", "male"] as const).map((g) => (
                    <button
                      key={g}
                      onClick={() => { setVoiceGenderFilter(g); setVoicePage(0); }}
                      className={cn(
                        "px-2 py-1.5 text-xs transition-colors",
                        voiceGenderFilter === g ? "bg-brand-500/15 text-brand-400" : "bg-surface-1 text-text-tertiary hover:text-text-secondary"
                      )}
                    >
                      {g === "all" ? "Все" : g === "female" ? "Ж" : "М"}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="Поиск…"
                  className="flex-1 rounded-lg border border-border bg-surface-1 px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary"
                  value={voiceSearch}
                  onChange={(e) => { setVoiceSearch(e.target.value); setVoicePage(0); }}
                />
              </div>
              {voicesLoading && heygenVoices.length === 0 ? (
                <div className="flex items-center justify-center py-4">
                  <LoadingSpinner size={16} />
                  <span className="ml-2 text-xs text-text-tertiary">Загрузка…</span>
                </div>
              ) : (
                <>
                  {(() => {
                    const VPAGE = 8;
                    const filtered = heygenVoices.filter((v) =>
                      !voiceSearch || v.name.toLowerCase().includes(voiceSearch.toLowerCase())
                    );
                    const totalP = Math.max(1, Math.ceil(filtered.length / VPAGE));
                    const paged = filtered.slice(voicePage * VPAGE, (voicePage + 1) * VPAGE);
                    return (
                      <>
                        <div className="grid grid-cols-2 gap-1.5">
                          {paged.map((v) => (
                            <button
                              key={v.voice_id}
                              onClick={() => setVoiceId(v.voice_id)}
                              className={cn(
                                "rounded-lg border px-2.5 py-2 text-left transition-all flex items-center gap-2",
                                voiceId === v.voice_id
                                  ? "border-brand-500 bg-brand-500/10 ring-1 ring-brand-500/30"
                                  : "border-border bg-surface-1 hover:border-brand-500/40"
                              )}
                            >
                              <div className="flex-1 min-w-0">
                                <p className={cn("text-xs font-medium truncate", voiceId === v.voice_id ? "text-brand-400" : "text-text-primary")}>
                                  {v.name}
                                </p>
                                <p className="text-[9px] text-text-tertiary">{v.gender ?? "—"} · {v.language ?? "—"}</p>
                              </div>
                              {v.preview_audio_url && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); playVoicePreview(v); }}
                                  className={cn(
                                    "shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] transition-colors",
                                    playingVoiceId === v.voice_id ? "bg-brand-500/20 text-brand-400" : "bg-surface-3 hover:bg-surface-2"
                                  )}
                                  title="Прослушать"
                                >
                                  {playingVoiceId === v.voice_id ? "⏸" : "▶"}
                                </button>
                              )}
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-[9px] text-text-tertiary">{filtered.length} голосов</span>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setVoicePage((p) => Math.max(0, p - 1))}
                              disabled={voicePage === 0}
                              className="text-[10px] text-text-tertiary hover:text-text-primary disabled:opacity-30"
                            >
                              ←
                            </button>
                            <span className="text-[9px] text-text-tertiary">{voicePage + 1}/{totalP}</span>
                            <button
                              onClick={() => {
                                if (voicePage >= totalP - 1 && voiceHasMore) loadMoreVoices();
                                setVoicePage((p) => Math.min(totalP - 1 + (voiceHasMore ? 1 : 0), p + 1));
                              }}
                              disabled={voicePage >= totalP - 1 && !voiceHasMore}
                              className="text-[10px] text-text-tertiary hover:text-text-primary disabled:opacity-30"
                            >
                              →
                            </button>
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </>
              )}
            </div>

            {/* Avatar grid with images */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary">Аватар</label>
              {(() => {
                const AVATARS_PER_PAGE = 6;
                const avatarList = avatars.length > 0 ? avatars : [
                  { avatar_id: "Anna_public_20240108", avatar_name: "Анна", preview_image_url: null },
                  { avatar_id: "Adrian_public_2_20240312", avatar_name: "Адриан", preview_image_url: null },
                  { avatar_id: "Kristin_public_3_20240108", avatar_name: "Кристин", preview_image_url: null },
                ];
                const totalPages = Math.ceil(avatarList.length / AVATARS_PER_PAGE);
                const paged = avatarList.slice(avatarPage * AVATARS_PER_PAGE, (avatarPage + 1) * AVATARS_PER_PAGE);
                return (
                  <>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                      {paged.map((a) => (
                        <button
                          key={a.avatar_id}
                          onClick={() => setAvatarId(a.avatar_id)}
                          className={cn(
                            "rounded-xl border p-2 flex flex-col items-center gap-1.5 transition-all relative group",
                            avatarId === a.avatar_id
                              ? "border-brand-500 bg-brand-500/10 ring-1 ring-brand-500/30"
                              : "border-border bg-surface-1 hover:border-brand-500/40"
                          )}
                        >
                          {a.preview_image_url ? (
                            <div className="relative w-12 h-12 rounded-full overflow-hidden bg-surface-3">
                              <img
                                src={a.preview_image_url}
                                alt={a.avatar_name}
                                className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                              />
                              <button
                                onClick={(e) => { e.stopPropagation(); setZoomedAvatar(a.preview_image_url); }}
                                className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-full"
                              >
                                <span className="text-white text-sm">🔍</span>
                              </button>
                            </div>
                          ) : (
                            <span className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center text-xl">👤</span>
                          )}
                          <span className={cn(
                            "text-[10px] font-medium truncate max-w-full",
                            avatarId === a.avatar_id ? "text-brand-400" : "text-text-primary"
                          )}>
                            {a.avatar_name}
                          </span>
                        </button>
                      ))}
                    </div>
                    {totalPages > 1 && (
                      <div className="flex items-center justify-center gap-3 mt-2">
                        <button
                          onClick={() => setAvatarPage((p) => Math.max(0, p - 1))}
                          disabled={avatarPage === 0}
                          className="text-xs text-text-tertiary hover:text-text-primary disabled:opacity-30"
                        >
                          ←
                        </button>
                        <span className="text-[10px] text-text-tertiary">{avatarPage + 1}/{totalPages}</span>
                        <button
                          onClick={() => setAvatarPage((p) => Math.min(totalPages - 1, p + 1))}
                          disabled={avatarPage >= totalPages - 1}
                          className="text-xs text-text-tertiary hover:text-text-primary disabled:opacity-30"
                        >
                          →
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* Zoom modal */}
            {zoomedAvatar && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setZoomedAvatar(null)}>
                <div className="relative max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
                  <img src={zoomedAvatar} alt="Avatar preview" className="w-full rounded-2xl shadow-lg" />
                  <button onClick={() => setZoomedAvatar(null)} className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors">✕</button>
                </div>
              </div>
            )}

            {/* HeyGen existing video ID */}
            <div className="border-t border-border pt-4 space-y-2">
              <label className="text-xs font-medium text-text-secondary">ID видео из HeyGen (необязательно)</label>
              <Input
                value={heygenExistingId}
                onChange={(e) => setHeygenExistingId(e.target.value)}
                placeholder="Вставьте video_id из HeyGen если аватар уже сгенерирован"
                className="font-mono text-xs"
              />
              {heygenExistingId.trim() && (
                <p className="text-[10px] text-brand-400">Сценарий генерироваться не будет — видео будет загружено по ID из HeyGen</p>
              )}
            </div>

            {heygenExistingId.trim() ? (
              <Button
                variant="primary"
                onClick={() => {
                  setTitle(productName || "Тест с готовым видео");
                  setFullScript("");
                  setBRollPrompts([]);
                  setAvatarGen({ status: "generating", startedAt: Date.now(), elapsed: 0 });
                  avatarAutoStarted.current = true;
                  setStep("media");
                  startPolling(heygenExistingId.trim(), Date.now());
                }}
                disabled={!productName.trim()}
                className="w-full"
              >
                Загрузить видео HeyGen и перейти к медиа →
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={handleGenerateScript}
                disabled={loading || !productName.trim() || prompt.trim().length < 10}
                className="w-full"
              >
                {loading ? <LoadingSpinner size={16} className="mr-2" /> : null}
                {loading ? "Генерируем сценарий..." : "Сгенерировать сценарий (GPT-4o)"}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* ──────── Step 2: Avatar & Backgrounds ─────────────────── */}
      {step === "media" && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-5 pb-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
                  <p className="text-sm text-text-tertiary mt-1">
                    Шаблон: {currentTempl?.name ?? selectedTemplate} · {currentTempl?.segments.length ?? 0} сегментов
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setStep("input")}>← Назад</Button>
              </div>
            </CardContent>
          </Card>

          {/* Full script */}
          <Card>
            <CardContent className="pt-5 pb-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-primary">Скрипт аватара (единый)</h3>
                <span className="text-xs text-text-tertiary">{fullScript.split(/\s+/).length} слов · ~{Math.round(fullScript.split(/\s+/).length / 2.5)}с</span>
              </div>
              <Textarea
                value={fullScript}
                onChange={(e) => setFullScript(e.target.value)}
                rows={6}
                className="text-sm"
              />
            </CardContent>
          </Card>

          {/* Avatar generation */}
          <Card>
            <CardContent className="pt-5 pb-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-primary">Аватар (HeyGen, чёрный фон)</h3>
                {avatarGen.status === "done" && <Badge variant="success" dot>Готово ({avatarDuration.toFixed(1)}с)</Badge>}
                {avatarGen.status === "generating" && <Badge variant="brand" dot>Генерация...</Badge>}
                {avatarGen.status === "error" && <Badge variant="danger" dot>Ошибка</Badge>}
              </div>

              {avatarGen.status === "generating" && (
                <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <LoadingSpinner size={14} className="text-purple-400" />
                      <span className="text-xs font-medium text-purple-400">Генерация аватара...</span>
                    </div>
                    <span className="text-xs font-mono text-text-tertiary">{fmtTime(avatarGen.elapsed)}</span>
                  </div>
                  <Progress value={Math.min(95, Math.round((avatarGen.elapsed ?? 0) / 1800))} className="h-1.5" />
                  <p className="text-xs text-text-tertiary">Генерируется одно длинное видео. Обычно 3-5 минут.</p>
                  {heygenVideoIdRef.current && (
                    <p className="text-[10px] text-text-tertiary font-mono">ID: {heygenVideoIdRef.current}</p>
                  )}
                </div>
              )}

              {avatarGen.status === "error" && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 space-y-2">
                  <p className="text-xs text-red-400">Ошибка: {avatarGen.error}</p>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={generateAvatar} className="flex-1">Повторить</Button>
                  </div>
                  {heygenVideoIdRef.current && (
                    <div className="border-t border-border pt-2 mt-2">
                      <p className="text-[10px] text-text-tertiary mb-1">Если видео создано в HeyGen — вставьте ID:</p>
                      <div className="flex gap-2">
                        <Input
                          value={manualVideoId || heygenVideoIdRef.current}
                          onChange={(e) => setManualVideoId(e.target.value)}
                          className="text-xs flex-1"
                        />
                        <Button variant="secondary" size="sm" onClick={() => { const vid = manualVideoId || heygenVideoIdRef.current; setManualVideoId(vid); pollManualVideoId(vid); }}>
                          Проверить
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {avatarGen.status === "done" && avatarUrl && (
                <div className="space-y-2">
                  <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-2 flex items-center gap-2">
                    <span className="text-green-400 text-sm">✓</span>
                    <span className="text-xs text-green-400">Аватар сгенерирован за {fmtTime(avatarGen.elapsed)}</span>
                  </div>
                  <video src={avatarUrl} controls className="max-h-48 rounded-lg" />
                  <Button variant="secondary" size="sm" onClick={generateAvatar} className="w-full">
                    Перегенерировать аватар
                  </Button>
                </div>
              )}

              {avatarGen.status === "idle" && (
                <div className="space-y-3">
                  <Button variant="secondary" size="sm" onClick={generateAvatar} className="w-full">
                    Генерировать аватар
                  </Button>
                  <div className="border-t border-border pt-3">
                    <p className="text-[10px] text-text-tertiary mb-1.5 uppercase tracking-wider">Или вставьте ID видео из HeyGen</p>
                    <div className="flex gap-2">
                      <Input
                        value={manualVideoId}
                        onChange={(e) => setManualVideoId(e.target.value)}
                        placeholder="HeyGen video ID"
                        className="text-xs flex-1"
                      />
                      <Button variant="secondary" size="sm" onClick={() => pollManualVideoId()} disabled={!manualVideoId.trim()}>
                        Загрузить
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Backgrounds */}
          <Card>
            <CardContent className="pt-5 pb-5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Фоны для монтажа</h3>
                  <p className="text-xs text-text-tertiary mt-0.5">
                    Загрузите изображения и видео продукта, которые будут использованы как фон
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => bgFileRef.current?.click()}
                  disabled={uploadingBg}
                >
                  {uploadingBg ? <LoadingSpinner size={14} className="mr-1" /> : null}
                  Загрузить фон
                </Button>
              </div>

              {/* b_roll prompts from GPT */}
              {bRollPrompts.length > 0 && (
                <div className="bg-surface-2 rounded-lg p-3 space-y-2">
                  <p className="text-xs font-medium text-text-tertiary">Рекомендации AI для фонов:</p>
                  {bRollPrompts.map((bp, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <Badge variant={bp.type === "video" ? "brand" : "success"} className="text-[10px] mt-0.5 shrink-0">
                        {bp.type === "video" ? "Видео" : "Фото"}
                      </Badge>
                      <p className="text-xs text-text-secondary">{bp.prompt}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Uploaded backgrounds */}
              {backgrounds.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  {backgrounds.map((bg, i) => (
                    <div key={i} className="border border-border rounded-lg p-2 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant={bg.type === "video" ? "brand" : "success"} className="text-[10px]">
                            {bg.type === "video" ? "Видео" : "Фото"}
                          </Badge>
                          <span className="text-xs text-text-secondary truncate max-w-[150px]">{bg.name}</span>
                        </div>
                        <button onClick={() => removeBg(i)} className="text-red-400 text-xs hover:text-red-300">✕</button>
                      </div>
                      {bg.type === "video" ? (
                        <video src={bg.url} controls className="max-h-24 rounded w-full object-cover" />
                      ) : (
                        <img src={bg.url} alt="" className="max-h-24 rounded w-full object-cover" />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {backgrounds.length === 0 && (
                <div className="border-2 border-dashed border-border rounded-lg p-6 text-center">
                  <p className="text-sm text-text-tertiary">Загрузите хотя бы 1 фон (изображение или видео продукта)</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Layout preview */}
          {currentTempl && (
            <Card>
              <CardContent className="pt-5 pb-5 space-y-3">
                <h3 className="text-sm font-semibold text-text-primary">Раскладка: {currentTempl.name}</h3>
                <div className="flex gap-1">
                  {currentTempl.segments.map((seg, i) => (
                    <div
                      key={i}
                      className={cn(
                        "rounded-lg p-2 text-center transition-all border",
                        seg.layout === "fullscreen" ? "bg-purple-500/10 border-purple-500/30" :
                        seg.layout === "voiceover" ? "bg-yellow-500/10 border-yellow-500/30" :
                        "bg-blue-500/10 border-blue-500/30"
                      )}
                      style={{ flex: seg.weight }}
                    >
                      <p className={cn(
                        "text-xs font-medium",
                        seg.layout === "fullscreen" ? "text-purple-400" :
                        seg.layout === "voiceover" ? "text-yellow-400" :
                        "text-blue-400"
                      )}>
                        {LAYOUT_LABELS[seg.layout] ?? seg.layout}
                      </p>
                      <p className="text-[10px] text-text-tertiary mt-0.5">
                        {Math.round(seg.weight * 100)}% · {seg.bg_type === "video" ? "видео" : "фото"}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex items-center justify-between pt-2">
            <div className="text-sm text-text-tertiary">
              {avatarGen.status === "generating" && "⏳ Генерация аватара..."}
              {avatarGen.status === "done" && backgrounds.length >= 1 && "✓ Всё готово для монтажа"}
              {avatarGen.status === "done" && backgrounds.length === 0 && "⚠ Загрузите хотя бы 1 фон"}
              {avatarGen.status === "error" && "⚠ Ошибка генерации аватара"}
              {avatarGen.status === "idle" && "⏳ Ожидание генерации аватара..."}
            </div>
            <Button
              variant="primary"
              disabled={!canCompose || avatarGen.status === "generating"}
              onClick={() => setStep("compose")}
            >
              Далее: Настройки монтажа →
            </Button>
          </div>
        </div>
      )}

      {/* ──────── Step 3: Compose settings ─────────────────────── */}
      {step === "compose" && (
        <Card>
          <CardContent className="pt-6 pb-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text-primary">Настройки монтажа</h2>
              <Button variant="ghost" size="sm" onClick={() => setStep("media")}>← К медиа</Button>
            </div>

            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                <input type="checkbox" checked={withSubtitles} onChange={(e) => setWithSubtitles(e.target.checked)} className="rounded" />
                Субтитры
              </label>
              {withSubtitles && (
                <div className="flex gap-2">
                  {SUB_STYLES.map((ss) => (
                    <button
                      key={ss.value}
                      onClick={() => setSubtitleStyle(ss.value as any)}
                      className={cn(
                        "px-3 py-1 rounded text-xs font-medium transition-all border",
                        subtitleStyle === ss.value
                          ? "border-brand-500 bg-brand-500/10 text-brand-400"
                          : "border-border bg-surface-1 text-text-tertiary hover:text-text-secondary"
                      )}
                    >
                      {ss.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* BGM */}
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                <input type="checkbox" checked={bgmEnabled} onChange={(e) => setBgmEnabled(e.target.checked)} className="rounded" />
                Фоновая музыка
              </label>
              {bgmEnabled && (
                <div className="space-y-2 pl-6">
                  <div className="flex items-center gap-3">
                    <Button variant="outline" size="sm" onClick={() => bgmFileRef.current?.click()} disabled={uploadingBgm}>
                      {uploadingBgm ? <LoadingSpinner size={14} className="mr-1" /> : null}
                      {bgmKey ? "Заменить" : "Загрузить MP3"}
                    </Button>
                    {bgmName && <span className="text-xs text-text-secondary truncate max-w-[200px]">{bgmName}</span>}
                    {bgmKey && (
                      <button onClick={() => { setBgmKey(""); setBgmName(""); }} className="text-xs text-red-400 hover:text-red-300">✕</button>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-text-tertiary w-16">Громкость</span>
                    <input
                      type="range" min="0.05" max="0.35" step="0.01"
                      value={bgmVolume} onChange={(e) => setBgmVolume(+e.target.value)}
                      className="flex-1 accent-brand-500"
                    />
                    <span className="text-xs text-text-secondary w-10 text-right">{Math.round(bgmVolume * 100)}%</span>
                  </div>
                </div>
              )}
            </div>

            {/* Summary */}
            <div className="bg-surface-2 rounded-lg p-4 space-y-2 text-sm">
              <p className="font-medium text-text-primary">Итого</p>
              <p className="text-text-secondary">
                Шаблон: {currentTempl?.name ?? selectedTemplate} · {currentTempl?.segments.length ?? 0} сегментов
              </p>
              <p className="text-text-secondary">
                Аватар: {avatarDuration.toFixed(1)}с · Фоны: {backgrounds.length} ({backgrounds.filter(b => b.type === "image").length} фото, {backgrounds.filter(b => b.type === "video").length} видео)
              </p>
              <p className="text-text-secondary">Субтитры: {withSubtitles ? subtitleStyle : "нет"}</p>
              <p className="text-text-secondary">Музыка: {bgmEnabled && bgmKey ? `${bgmName} (${Math.round(bgmVolume * 100)}%)` : "нет"}</p>
              <p className="text-text-tertiary text-xs">Color key: чёрный фон · Тенант: system</p>
            </div>

            <Button variant="primary" onClick={handleCompose} disabled={composing} className="w-full">
              {composing ? <LoadingSpinner size={16} className="mr-2" /> : null}
              {composing ? "Собираем видео..." : "Собрать видео"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ──────── Step 4: Result ───────────────────────────────── */}
      {step === "result" && result && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-6 pb-6 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-text-primary">Результат</h2>
                <Badge variant="success">Готово</Badge>
              </div>

              <video src={result.output_url} controls className="w-full max-h-[500px] rounded-xl bg-black" />

              <div className="grid grid-cols-3 gap-4 text-sm">
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-text-tertiary text-xs">Длительность</p>
                  <p className="text-text-primary font-medium">{result.compose_result.duration_sec.toFixed(1)}с</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-text-tertiary text-xs">Размер</p>
                  <p className="text-text-primary font-medium">{(result.compose_result.file_size_bytes / 1024 / 1024).toFixed(2)} МБ</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-text-tertiary text-xs">Время сборки</p>
                  <p className="text-text-primary font-medium">{(result.elapsed_ms / 1000).toFixed(1)}с</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-text-tertiary text-xs">Разрешение</p>
                  <p className="text-text-primary font-medium">{result.compose_result.width}×{result.compose_result.height}</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-text-tertiary text-xs">Шаблон</p>
                  <p className="text-text-primary font-medium">{layoutTemplates[result.layout_template]?.name ?? result.layout_template}</p>
                </div>
              </div>

              <div className="flex gap-3">
                <a href={result.output_url} download className="flex-1">
                  <Button variant="secondary" className="w-full">Скачать видео</Button>
                </a>
                <Button
                  variant="primary"
                  className="flex-1"
                  onClick={() => {
                    setStep("input");
                    setResult(null);
                    setFullScript("");
                    setTitle("");
                    setBackgrounds([]);
                    setAvatarKey("");
                    setAvatarUrl("");
                    setAvatarDuration(0);
                    setAvatarGen({ status: "idle" });
                  }}
                >
                  Новый тест
                </Button>
              </div>

              {/* Re-edit shortcuts */}
              <div className="border-t border-border pt-4 space-y-3">
                <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Внести правки и пересобрать</p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => { setResult(null); setStep("input"); }}
                    className="rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-left hover:border-brand-500/40 transition-all group"
                  >
                    <p className="text-xs font-medium text-text-primary group-hover:text-brand-400">1. Скрипт и промпт</p>
                    <p className="text-[10px] text-text-tertiary mt-0.5">Изменить текст, голос, аватар</p>
                  </button>
                  <button
                    onClick={() => { setResult(null); setStep("media"); }}
                    className="rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-left hover:border-brand-500/40 transition-all group"
                  >
                    <p className="text-xs font-medium text-text-primary group-hover:text-brand-400">2. Медиа и фоны</p>
                    <p className="text-[10px] text-text-tertiary mt-0.5">Заменить фоны, пересоздать аватар</p>
                  </button>
                  <button
                    onClick={() => { setResult(null); setStep("compose"); }}
                    className="rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-left hover:border-brand-500/40 transition-all group"
                  >
                    <p className="text-xs font-medium text-text-primary group-hover:text-brand-400">3. Монтаж</p>
                    <p className="text-[10px] text-text-tertiary mt-0.5">Субтитры, музыка, шаблон</p>
                  </button>
                </div>
                <p className="text-[10px] text-text-tertiary">
                  Аватар и фоны сохранены — пересборка монтажа не требует повторной генерации HeyGen
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

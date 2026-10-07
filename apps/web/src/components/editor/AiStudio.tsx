"use client";

/**
 * AI-студия редактора: сценарий (LLM-цепочка OpenRouter → GPTunnel) и озвучка
 * (Fish Audio) — для всего проекта или для каждого клипа отдельно.
 *
 * Ключи только на сервере (Админ → Настройки). Длина текста считается по
 * откалиброванному темпу выбранного голоса; после озвучки показывается
 * фактическая длительность и предлагается подогнать текст.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, CardContent, Badge, LoadingSpinner } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import {
  editorApi,
  type AiStatus, type EditClip, type EditProjectDetail, type FishAudioVoice, type GeneratedScriptResult,
  type GeneratedVoiceResult,
} from "@/lib/api";

const STYLES = [
  { id: "blogger", label: "Блогер / Находка", desc: "Живой UGC" },
  { id: "story", label: "Боль → Решение", desc: "До / после" },
  { id: "review", label: "Тест / Обзор", desc: "Честная проверка" },
  { id: "hype", label: "Вирусный POV", desc: "Шок-крючок" },
  { id: "educational", label: "Лайфхак", desc: "Экспертный совет" },
  { id: "sales", label: "Рекомендация", desc: "Выгода" },
  { id: "humor", label: "С юмором", desc: "Ирония" },
  { id: "minimal", label: "Коротко", desc: "Факты + CTA" },
] as const;

const CTAS = [
  { id: "article", label: "📦 Артикул" },
  { id: "direct", label: "📩 Слово в директ" },
  { id: "auto", label: "✨ Авто" },
  { id: "none", label: "Без призыва" },
] as const;

const EMOTIONS = [
  { tag: "excited", label: "🔥 Драйв" }, { tag: "confident", label: "💼 Уверенно" },
  { tag: "whispering", label: "🤫 Шёпот" }, { tag: "surprised", label: "😲 Удивление" },
  { tag: "gasp", label: "😱 Вздох" }, { tag: "curious", label: "🧐 Интрига" },
  { tag: "laughing", label: "😂 Смех" }, { tag: "calm", label: "😌 Спокойно" },
  { tag: "urgent", label: "⚡ Срочно" }, { tag: "sigh", label: "😮‍💨 Выдох" },
];

const DEFAULT_WPS = 2.3;
type CtaId = (typeof CTAS)[number]["id"];
type Target = "project" | string; // clip id

function spokenWords(text: string): number {
  const clean = text.replace(/\[[a-zA-Z_\s-]+\]/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ").trim();
  return clean ? clean.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

function clipSeconds(c: EditClip): number {
  if (Number(c.durationSec) > 0) return Number(c.durationSec);
  const segs = c.edl?.segments ?? [];
  const sum = segs.reduce((t, s) => t + Math.max(0, s.end - s.start), 0) - (c.edl?.transitions ? 0.35 * Math.max(0, segs.length - 1) : 0);
  return Math.max(5, Math.round(sum * 10) / 10);
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function AiStudio({ project, onChanged }: { project: EditProjectDetail; onChanged: () => Promise<void> | void }) {
  const cfg = (project.config ?? {}) as Record<string, any>;
  const included = useMemo(() => project.clips.filter((c) => c.included), [project.clips]);

  const [status, setStatus] = useState<AiStatus | null>(null);
  const [voices, setVoices] = useState<FishAudioVoice[]>([]);
  const [target, setTarget] = useState<Target>(included[0]?.id ?? "project");

  // brief
  const [productName, setProductName] = useState<string>(project.name);
  const [productInfo, setProductInfo] = useState<string>(cfg.productInfo ?? "");
  const [audience, setAudience] = useState<string>(cfg.audience ?? "");
  const [style, setStyle] = useState<string>(cfg.scriptStyle ?? "blogger");
  const [cta, setCta] = useState<CtaId>((cfg.ctaType as CtaId) ?? "article");
  const [directWord, setDirectWord] = useState<string>(cfg.directWord ?? "ХОЧУ");

  // voice
  const [voiceId, setVoiceId] = useState<string>(cfg.voiceId ?? "");
  const [customVoice, setCustomVoice] = useState("");
  const [speed, setSpeed] = useState<number>(Number(cfg.voiceSpeed) || 1);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // script + result
  const [script, setScript] = useState("");
  const [lastScript, setLastScript] = useState<GeneratedScriptResult | null>(null);
  const [lastVoice, setLastVoice] = useState<GeneratedVoiceResult | null>(null);
  const [wps, setWps] = useState(DEFAULT_WPS);
  const [busy, setBusy] = useState<null | "script" | "fit" | "rewrite" | "voice" | "bulk">(null);
  const [error, setError] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number; failed: string[] } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const targetClip = target === "project" ? null : project.clips.find((c) => c.id === target) ?? null;
  const targetSec = targetClip ? clipSeconds(targetClip) : (included.length ? included.reduce((t, c) => t + clipSeconds(c), 0) / included.length : Number(project.targetClipSeconds) || 30);
  const effectiveVoice = customVoice.trim() || voiceId || voices[0]?.id || "";
  const words = spokenWords(script);
  const estSec = words / wps;
  const existingVoiceUrl = targetClip ? targetClip.voiceoverUrl : project.voiceoverUrl;
  const existingVoice = targetClip?.edl?.voiceover;

  useEffect(() => {
    editorApi.aiStatus().then(setStatus).catch(() => setStatus(null));
    editorApi.getVoices().then((r) => {
      setVoices(r.voices);
      setVoiceId((v) => v || r.voices[0]?.id || "");
    }).catch(() => {});
  }, []);

  // Load the script/voice stored for the selected target.
  useEffect(() => {
    setError(null);
    setLastVoice(null);
    if (targetClip) {
      setScript(targetClip.edl?.script?.text ?? targetClip.edl?.voiceover?.text ?? "");
    } else {
      setScript(cfg.voiceoverText ?? cfg.generatedScript ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  function insertTag(tag: string) {
    const el = textRef.current;
    const ins = `[${tag}] `;
    if (!el) return setScript((s) => `${s} ${ins}`);
    const { selectionStart: a, selectionEnd: b, value } = el;
    setScript(value.slice(0, a) + ins + value.slice(b));
    setTimeout(() => { el.focus(); el.setSelectionRange(a + ins.length, a + ins.length); }, 0);
  }

  async function preview(id: string) {
    setPreviewing(id);
    try {
      const { audioUrl } = await editorApi.voicePreview(id, speed);
      audioRef.current?.pause();
      audioRef.current = new Audio(audioUrl);
      await audioRef.current.play();
    } catch (e: any) {
      setError(e?.message ?? "Не удалось воспроизвести образец");
    } finally {
      setPreviewing(null);
    }
  }

  const brief = () => ({
    clipId: targetClip?.id,
    style,
    targetSeconds: Math.round(targetSec * 10) / 10,
    productName: productName.trim() || project.name,
    productInfo: productInfo.trim() || undefined,
    audience: audience.trim() || undefined,
    ctaType: cta,
    directWord: cta === "direct" || cta === "auto" ? directWord.trim() || "ХОЧУ" : undefined,
    voiceId: effectiveVoice || undefined,
    speed,
    captionsCount: 3,
  });

  async function writeScript(mode: "generate" | "fit" | "rewrite") {
    setBusy(mode === "generate" ? "script" : mode);
    setError(null);
    try {
      const r = await editorApi.generateScript(project.id, {
        ...brief(),
        mode,
        ...(mode !== "generate" ? { currentScript: script } : {}),
        ...(mode === "fit" && lastVoice ? { measuredSeconds: lastVoice.durationSec } : {}),
      });
      setScript(r.script);
      setLastScript(r);
      if (r.wps > 0) setWps(r.wps);
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Ошибка генерации сценария");
    } finally {
      setBusy(null);
    }
  }

  async function voice() {
    if (!script.trim()) return;
    setBusy("voice");
    setError(null);
    try {
      const r = await editorApi.generateVoice(project.id, {
        text: script, voiceId: effectiveVoice || undefined, speed, clipId: targetClip?.id,
      });
      setLastVoice(r);
      if (r.wps > 0) setWps(r.wps);
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Ошибка озвучки");
    } finally {
      setBusy(null);
    }
  }

  async function removeVoice() {
    setError(null);
    try {
      if (targetClip) await editorApi.deleteClipVoice(project.id, targetClip.id);
      else await editorApi.deleteProjectVoice(project.id);
      setLastVoice(null);
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Не удалось убрать озвучку");
    }
  }

  /** Script + voice for every included clip, each with its own hook. */
  async function voiceAllClips() {
    if (!included.length) return;
    if (!confirm(`Написать сценарий и озвучить ${included.length} клип(ов)? Существующая озвучка клипов будет заменена.`)) return;
    setBusy("bulk");
    setError(null);
    const failed: string[] = [];
    setBulk({ done: 0, total: included.length, failed });
    for (let i = 0; i < included.length; i++) {
      const c = included[i];
      try {
        const s = await editorApi.generateScript(project.id, { ...brief(), clipId: c.id, targetSeconds: clipSeconds(c), mode: "generate" });
        await editorApi.generateVoice(project.id, { text: s.script, voiceId: effectiveVoice || undefined, speed, clipId: c.id });
      } catch (e: any) {
        failed.push(`${c.title || `Клип ${i + 1}`}: ${e?.message ?? "ошибка"}`);
      }
      setBulk({ done: i + 1, total: included.length, failed: [...failed] });
    }
    await onChanged();
    setBusy(null);
  }

  const llmOk = Boolean(status?.llmProviders.length);
  const fishOk = Boolean(status?.fishAudio);
  const diff = estSec - targetSec;
  const synced = words > 0 && Math.abs(diff) <= Math.max(1.5, targetSec * 0.07);

  return (
    <Card className="border-brand-500/40 shadow-elevation-2 animate-fade-in">
      <CardContent className="p-5 space-y-4">
        {/* Header: what + provider status */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
          <div>
            <h3 className="font-semibold text-text-primary">✨ AI-студия: сценарий и озвучка</h3>
            <p className="text-xs text-text-tertiary">Текст пишется под длину клипа и темп выбранного голоса; субтитры повторяют сценарий слово в слово.</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-2xs">
            <StatusPill ok={llmOk} label={llmOk ? `Сценарии: ${status!.llmProviders.join(" → ")}` : "Сценарии: нет ключа"} />
            <StatusPill ok={fishOk} label={fishOk ? "Озвучка: Fish Audio" : "Озвучка: нет ключа"} />
            {(!llmOk || !fishOk) && (
              <a href="/admin/settings" className="text-brand-400 hover:underline">настроить ключи →</a>
            )}
          </div>
        </div>

        {/* Target */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs font-semibold uppercase text-text-tertiary mr-1">Для чего:</span>
          {project.clips.length > 0 && project.clips.map((c, i) => (
            <button key={c.id} type="button" onClick={() => setTarget(c.id)}
              className={cn("rounded-lg px-2.5 py-1 text-xs transition-all",
                target === c.id ? "bg-brand-500/20 text-brand-400 ring-1 ring-brand-500/40 font-medium" : "bg-surface-2 text-text-secondary hover:text-text-primary",
                !c.included && "opacity-50")}>
              {c.title || `Клип ${i + 1}`} · {fmt(clipSeconds(c))}{c.edl?.voiceover ? " 🎙" : ""}
            </button>
          ))}
          <button type="button" onClick={() => setTarget("project")}
            className={cn("rounded-lg px-2.5 py-1 text-xs transition-all",
              target === "project" ? "bg-brand-500/20 text-brand-400 ring-1 ring-brand-500/40 font-medium" : "bg-surface-2 text-text-secondary hover:text-text-primary")}>
            Весь проект{project.voiceoverUrl ? " 🎙" : ""}
          </button>
          {included.length > 1 && (
            <Button size="xs" variant="secondary" className="ml-auto" loading={busy === "bulk"} disabled={!llmOk || !fishOk || busy !== null}
              onClick={voiceAllClips}>
              ⚡ Сценарий + озвучка для всех {included.length} клипов
            </Button>
          )}
        </div>
        {bulk && (
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs space-y-1">
            <div className="flex items-center gap-2">
              {busy === "bulk" && <LoadingSpinner size={12} />}
              <span className="text-text-secondary">Озвучено {bulk.done} из {bulk.total}</span>
              <div className="h-1 flex-1 rounded-full bg-surface-3 overflow-hidden">
                <div className="h-full bg-brand-500 transition-all" style={{ width: `${(bulk.done / bulk.total) * 100}%` }} />
              </div>
            </div>
            {bulk.failed.map((f) => <p key={f} className="text-danger">{f}</p>)}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-3">
          {/* 1. Brief */}
          <section className="space-y-2.5">
            <h4 className="text-xs font-semibold uppercase text-text-tertiary">1. Бриф</h4>
            <input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="Товар / тема"
              className={inputCls} />
            <textarea rows={3} value={productInfo} onChange={(e) => setProductInfo(e.target.value)}
              placeholder="Факты о товаре: что умеет, чем отличается, для кого. AI использует только их — ничего не выдумывает."
              className={cn(inputCls, "resize-none leading-relaxed")} />
            <input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Аудитория (необязательно): мамы, автолюбители…"
              className={inputCls} />
            <div className="grid grid-cols-2 gap-1.5">
              {STYLES.map((s) => (
                <button key={s.id} type="button" onClick={() => setStyle(s.id)}
                  className={cn("rounded px-2 py-1.5 text-left transition-all",
                    style === s.id ? "bg-brand-500/20 text-brand-400 ring-1 ring-brand-500/40" : "bg-surface-2 text-text-secondary hover:text-text-primary")}>
                  <div className="text-2xs font-medium">{s.label}</div>
                  <div className="text-2xs text-text-tertiary">{s.desc}</div>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {CTAS.map((c) => (
                <button key={c.id} type="button" onClick={() => setCta(c.id)}
                  className={cn("rounded px-2 py-1 text-2xs transition-all",
                    cta === c.id ? "bg-brand-500/20 text-brand-400 ring-1 ring-brand-500/40" : "bg-surface-2 text-text-secondary")}>
                  {c.label}
                </button>
              ))}
            </div>
            {(cta === "direct" || cta === "auto") && (
              <input value={directWord} onChange={(e) => setDirectWord(e.target.value.toUpperCase())} placeholder="Кодовое слово"
                className={cn(inputCls, "font-mono uppercase")} />
            )}
          </section>

          {/* 2. Script */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase text-text-tertiary">2. Сценарий</h4>
              <span className={cn("rounded px-1.5 py-0.5 font-mono text-2xs",
                words === 0 ? "bg-surface-2 text-text-tertiary" : synced ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}
                title="Оценка по откалиброванному темпу выбранного голоса">
                {words} слов · ~{estSec.toFixed(1)}с / {targetSec.toFixed(0)}с
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {EMOTIONS.map((em) => (
                <button key={em.tag} type="button" onClick={() => insertTag(em.tag)} title={`[${em.tag}]`}
                  className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-2xs text-text-secondary hover:text-brand-300">
                  {em.label}
                </button>
              ))}
            </div>
            <textarea ref={textRef} rows={9} value={script} onChange={(e) => setScript(e.target.value)}
              placeholder="Нажмите «Написать» — или вставьте свой текст. Теги [excited] управляют эмоцией диктора и не попадают в субтитры."
              className={cn(inputCls, "resize-y leading-relaxed")} />
            <div className="grid grid-cols-3 gap-1.5 [&>button]:whitespace-nowrap [&>button]:px-1.5">
              <Button size="sm" variant="primary" loading={busy === "script"} disabled={!llmOk && !productInfo.trim() || busy !== null}
                onClick={() => writeScript("generate")}>⚡ Написать</Button>
              <Button size="sm" variant="secondary" loading={busy === "rewrite"} disabled={!script.trim() || busy !== null}
                onClick={() => writeScript("rewrite")} title="Тот же смысл, другие слова и хук">🔁 Вариант</Button>
              <Button size="sm" variant="secondary" loading={busy === "fit"} disabled={!script.trim() || busy !== null}
                onClick={() => writeScript("fit")} title={`Подогнать длину под ${targetSec.toFixed(0)}с`}>📏 Подогнать</Button>
            </div>
            {lastScript && (
              <div className="space-y-1 text-2xs">
                <div className="flex flex-wrap items-center gap-1.5 text-text-tertiary">
                  <Badge variant={lastScript.provider === "template" ? "warning" : "outline"}>
                    {lastScript.provider === "template" ? "шаблон (AI недоступен)" : `${lastScript.provider} · ${lastScript.model}`}
                  </Badge>
                  <span>хук: «{lastScript.hook}»</span>
                </div>
                {lastScript.notes.map((n) => <p key={n} className="text-warning">• {n}</p>)}
                {lastScript.captions.length > 0 && (
                  <details className="rounded bg-surface-2/60 px-2 py-1">
                    <summary className="cursor-pointer text-text-secondary">Подписи к постам ({lastScript.captions.length})</summary>
                    <ul className="mt-1 space-y-1.5">
                      {lastScript.captions.map((c, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="flex-1 text-text-secondary">{c.caption} <span className="text-brand-400">{c.hashtags.join(" ")}</span></span>
                          <button type="button" className="text-text-tertiary hover:text-brand-400"
                            onClick={() => navigator.clipboard?.writeText(`${c.caption}\n\n${c.hashtags.join(" ")}`)}>копировать</button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </section>

          {/* 3. Voice */}
          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase text-text-tertiary">3. Голос</h4>
            <div className="max-h-56 space-y-1 overflow-auto pr-1">
              {voices.map((v) => (
                <div key={v.id}
                  className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5 transition-all cursor-pointer",
                    effectiveVoice === v.id && !customVoice.trim() ? "bg-brand-500/15 ring-1 ring-brand-500/40" : "bg-surface-2 hover:bg-surface-3")}
                  onClick={() => { setVoiceId(v.id); setCustomVoice(""); }}>
                  <span className="text-sm">{v.gender === "female" ? "♀" : v.gender === "male" ? "♂" : "◌"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-text-primary">{v.name}</div>
                    <div className="truncate text-2xs text-text-tertiary">{v.description}</div>
                  </div>
                  <button type="button" disabled={!fishOk || previewing !== null}
                    onClick={(e) => { e.stopPropagation(); void preview(v.id); }}
                    className="rounded px-1.5 py-0.5 text-2xs text-brand-400 hover:bg-brand-500/10 disabled:opacity-40"
                    title="Прослушать образец">
                    {previewing === v.id ? "…" : "▶"}
                  </button>
                </div>
              ))}
            </div>
            <input value={customVoice} onChange={(e) => setCustomVoice(e.target.value)}
              placeholder="Или свой Voice ID с fish.audio" className={cn(inputCls, "text-2xs")} />
            <div className="flex items-center gap-2 text-xs">
              <span className="text-text-secondary">Скорость</span>
              <input type="range" min={0.8} max={1.3} step={0.05} value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))} className="flex-1 accent-brand-500" />
              <span className="w-10 text-right font-mono text-brand-400">{speed.toFixed(2)}×</span>
            </div>
            <Button size="sm" variant="primary" className="w-full" loading={busy === "voice"} disabled={!script.trim() || !fishOk || busy !== null}
              onClick={voice}>
              🎙 Озвучить {targetClip ? "клип" : "проект"}
            </Button>

            {(lastVoice || existingVoiceUrl) && (
              <div className="space-y-1.5 rounded-lg bg-surface-2/70 p-2">
                <audio controls src={lastVoice?.audioUrl ?? existingVoiceUrl ?? undefined} className="h-8 w-full" />
                {(() => {
                  const dur = lastVoice?.durationSec ?? existingVoice?.durationSec;
                  if (!dur) return null;
                  const d = dur - targetSec;
                  const okLen = Math.abs(d) <= Math.max(1.5, targetSec * 0.07);
                  return (
                    <div className="flex flex-wrap items-center justify-between gap-1 text-2xs">
                      <span className={okLen ? "text-success" : "text-warning"}>
                        Голос {dur.toFixed(1)}с при клипе {targetSec.toFixed(1)}с {okLen ? "✓" : d > 0 ? `(+${d.toFixed(1)}с — видео замедлится/повторится)` : `(${d.toFixed(1)}с — видео подрежется)`}
                      </span>
                      {!okLen && lastVoice && (
                        <button type="button" className="text-brand-400 hover:underline" disabled={busy !== null}
                          onClick={() => writeScript("fit")}>подогнать текст</button>
                      )}
                    </div>
                  );
                })()}
                <button type="button" onClick={removeVoice} className="text-2xs text-danger/80 hover:text-danger">убрать озвучку</button>
              </div>
            )}
          </section>
        </div>

        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500";

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5", ok ? "bg-success/10 text-success" : "bg-warning/10 text-warning")}>
      <span className={cn("h-1.5 w-1.5 rounded-full", ok ? "bg-success" : "bg-warning")} />
      {label}
    </span>
  );
}

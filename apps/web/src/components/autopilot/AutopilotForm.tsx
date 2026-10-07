"use client";

/**
 * Autopilot configuration form — shared by "create" (/autopilot) and "edit"
 * (/autopilot/[id]). Four sections mirror the pipeline the loop runs every day:
 * sources → AI script & voice → uniquify → phone-farm publishing, with a live
 * "how it will work" summary computed by POST /autopilots/preview.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, CardContent, Badge, LoadingSpinner } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import {
  autopilotApi, uniquifyApi,
  type AutopilotInput, type AutopilotMeta, type AutopilotPreview, type BgmTrack,
} from "@/lib/api";

// ── Options ───────────────────────────────────────────────────────────────────

const SCRIPT_STYLES = [
  { id: "blogger", label: "Блогер / Находка", desc: "Распаковка, восторг, живой UGC" },
  { id: "story", label: "Боль → Решение", desc: "До/После, проблема и выход" },
  { id: "review", label: "Тест / Обзор", desc: "Честный краш-тест" },
  { id: "hype", label: "Вирусный POV", desc: "Шок-крючок, динамика" },
  { id: "educational", label: "Лайфхак", desc: "Экспертный совет" },
  { id: "sales", label: "Рекомендация", desc: "Нативная продажа" },
  { id: "humor", label: "С юмором", desc: "Лёгкая ирония" },
  { id: "minimal", label: "Минимализм", desc: "Коротко и по делу" },
];

const SUBTITLE_STYLES = [
  { value: "tiktok", label: "TikTok", cls: "font-black text-warning" },
  { value: "mrbeast", label: "MrBeast", cls: "font-black text-cyan-400" },
  { value: "neon_glow", label: "Neon", cls: "font-bold text-fuchsia-400" },
  { value: "fire_hype", label: "Fire", cls: "font-black text-orange-400" },
  { value: "single_word", label: "1 слово", cls: "font-black text-amber-300" },
  { value: "cinematic", label: "Cinema", cls: "font-medium text-text-primary" },
  { value: "minimal", label: "Minimal", cls: "font-light text-text-secondary" },
  { value: "none", label: "Без субтитров", cls: "text-text-tertiary" },
];

const PLATFORMS = [
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "youtube_shorts", label: "YouTube Shorts" },
];

const TIMEZONES = [
  "Europe/Moscow", "Europe/Kaliningrad", "Europe/Samara", "Asia/Yekaterinburg", "Asia/Omsk",
  "Asia/Novosibirsk", "Asia/Krasnoyarsk", "Asia/Irkutsk", "Asia/Vladivostok", "Asia/Almaty",
  "Europe/Minsk", "UTC",
];

const TIME_PRESETS: { label: string; times: string[] }[] = [
  { label: "2× в день", times: ["11:00", "19:00"] },
  { label: "3× в день", times: ["09:30", "14:00", "19:30"] },
  { label: "4× в день", times: ["08:30", "12:30", "16:30", "20:30"] },
];

export const AUTOPILOT_DEFAULTS: AutopilotInput = {
  name: "",
  projectId: "",
  montageMode: "multi",
  sourcesPerMontage: 3,
  sourceStrategy: "fresh_first",
  pace: "normal",
  targetSeconds: 30,
  aspect: "9:16",
  subtitleStyle: "tiktok",
  smartCrop: true,
  bgmKeys: [],
  productInfo: "",
  scriptStyles: ["blogger", "story", "hype"],
  ctaType: "article",
  directWord: "ХОЧУ",
  voiceIds: [],
  voiceSpeed: 1,
  uniquifyMode: "preserve_context",
  stealthLevel: "maximum",
  variantsPerMontage: null,
  accountGroupId: null,
  socialAccountIds: [],
  platforms: [],
  publishTimes: ["09:30", "14:00", "19:30"],
  timezone: "Europe/Moscow",
  jitterMinutes: 20,
  staggerMinutes: 7,
  minHealth: 30,
  captionTemplate: "",
  hashtags: [],
  bufferWindows: 2,
  maxParallelBatches: 2,
};

// ── Small building blocks ─────────────────────────────────────────────────────

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-sm font-semibold text-brand-400">
            {n}
          </span>
          <div>
            <h3 className="font-semibold text-text-primary">{title}</h3>
            {hint && <p className="text-xs text-text-tertiary mt-0.5">{hint}</p>}
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-xs font-medium text-text-secondary">{label}</label>
        {hint && <span className="text-2xs text-text-tertiary">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Pill({ active, onClick, children, className }: {
  active: boolean; onClick: () => void; children: React.ReactNode; className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg px-3 py-1.5 text-xs font-medium transition-all text-left",
        active
          ? "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/40"
          : "bg-surface-2 text-text-secondary hover:text-text-primary hover:bg-surface-3",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Range({ value, min, max, step = 1, onChange, suffix }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; suffix?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-brand-500" />
      <span className="w-16 text-right font-mono text-sm text-brand-400">{value}{suffix}</span>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500";

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

// ── Form ──────────────────────────────────────────────────────────────────────

export function AutopilotForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<AutopilotInput>;
  submitLabel: string;
  onSubmit: (v: AutopilotInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const [v, setV] = useState<AutopilotInput>({ ...AUTOPILOT_DEFAULTS, ...initial } as AutopilotInput);
  const [meta, setMeta] = useState<AutopilotMeta | null>(null);
  const [bgm, setBgm] = useState<BgmTrack[]>([]);
  const [preview, setPreview] = useState<AutopilotPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTime, setNewTime] = useState("12:00");
  const [hashtagInput, setHashtagInput] = useState((initial?.hashtags ?? []).join(" "));
  const [targetMode, setTargetMode] = useState<"all" | "group" | "accounts">(
    initial?.accountGroupId ? "group" : initial?.socialAccountIds?.length ? "accounts" : "all",
  );

  const set = <K extends keyof AutopilotInput>(k: K, val: AutopilotInput[K]) => setV((p) => ({ ...p, [k]: val }));

  useEffect(() => {
    autopilotApi.meta().then((m) => {
      setMeta(m);
      setV((p) => (p.projectId || m.projects.length === 0 ? p : { ...p, projectId: m.projects[0].id }));
    }).catch(() => setMeta({ projects: [], groups: [], voices: [], aiKeys: { openrouter: false, fishAudio: false } }));
    uniquifyApi.listBgm().then((r) => setBgm(r.items)).catch(() => setBgm([]));
  }, []);

  // Live preview (debounced) of accounts/sources/posts-per-day.
  const previewKey = JSON.stringify([v.projectId, v.accountGroupId, v.socialAccountIds, v.platforms, v.minHealth, v.publishTimes, v.jitterMinutes, targetMode]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setPreviewing(true);
      // In "accounts" mode list ALL phones (the picker needs them); the
      // selection is applied locally below.
      const body = scoped(v, targetMode);
      autopilotApi.preview(targetMode === "accounts" ? { ...body, socialAccountIds: [] } : body)
        .then(setPreview)
        .catch(() => setPreview(null))
        .finally(() => setPreviewing(false));
    }, 400);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const project = meta?.projects.find((p) => p.id === v.projectId);
  const windows = v.publishTimes.length;
  const eligible = targetMode === "accounts"
    ? (preview?.accounts ?? []).filter((a) => a.ok && v.socialAccountIds.includes(a.id)).length
    : preview?.eligible ?? 0;
  const postsPerDay = eligible * windows;

  async function submit() {
    setError(null);
    if (!v.name.trim()) return setError("Укажите название");
    if (!v.projectId) return setError("Выберите проект с исходниками");
    if (v.publishTimes.length === 0) return setError("Добавьте хотя бы одно окно публикации");
    if (targetMode === "group" && !v.accountGroupId) return setError("Выберите группу телефонов");
    if (targetMode === "accounts" && v.socialAccountIds.length === 0) return setError("Отметьте аккаунты");
    setSaving(true);
    try {
      await onSubmit({
        ...scoped(v, targetMode),
        hashtags: hashtagInput.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean).slice(0, 30),
      });
    } catch (e: any) {
      setError(e?.message ?? "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  const allDeviceAccounts = preview?.accounts ?? [];
  const deviceAccounts = targetMode === "accounts"
    ? allDeviceAccounts.filter((a) => v.socialAccountIds.includes(a.id))
    : allDeviceAccounts;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4 min-w-0">
        {/* ── 1. Project & montage ─────────────────────────────────────────── */}
        <Section n={1} title="Проект и монтаж" hint="Откуда берём footage и как собираем ролик">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Название автопилота">
              <input className={inputCls} value={v.name} onChange={(e) => set("name", e.target.value)} placeholder="Плойка — ежедневный поток" />
            </Field>
            <Field label="Проект" hint={project ? `${project.sourceCount} исходников` : undefined}>
              <select className={inputCls} value={v.projectId} onChange={(e) => set("projectId", e.target.value)}>
                {!meta && <option>Загрузка…</option>}
                {meta?.projects.length === 0 && <option value="">Нет проектов — создайте в «Projects»</option>}
                {meta?.projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {p.sourceCount} видео</option>
                ))}
              </select>
            </Field>
          </div>
          {project && project.sourceCount === 0 && (
            <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
              В проекте нет загруженных исходников. Загрузите footage в проект — автопилот возьмёт его оттуда.
            </p>
          )}

          <Field label="Режим монтажа">
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                { id: "single", title: "Из одного видео", desc: "Каждый ролик — динамичная нарезка одного исходника под новую озвучку" },
                { id: "multi", title: "Из нескольких видео", desc: "Каждый ролик собирается из 2–10 исходников — больше разнообразия" },
              ] as const).map((m) => (
                <button key={m.id} type="button" onClick={() => set("montageMode", m.id)}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-all",
                    v.montageMode === m.id ? "border-brand-500/60 bg-brand-500/10" : "border-border bg-surface-1 hover:border-brand-500/30",
                  )}>
                  <div className="text-sm font-medium text-text-primary">{m.title}</div>
                  <div className="mt-0.5 text-xs text-text-tertiary">{m.desc}</div>
                </button>
              ))}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            {v.montageMode === "multi" && (
              <Field label="Исходников в одном ролике">
                <Range value={v.sourcesPerMontage} min={2} max={10} onChange={(n) => set("sourcesPerMontage", n)} />
              </Field>
            )}
            <Field label="Длительность ролика" hint="точная длина = длина озвучки">
              <Range value={v.targetSeconds} min={10} max={90} step={5} onChange={(n) => set("targetSeconds", n)} suffix="с" />
            </Field>
          </div>

          <Field label="Какие исходники брать">
            <div className="flex flex-wrap gap-2">
              <Pill active={v.sourceStrategy === "fresh_first"} onClick={() => set("sourceStrategy", "fresh_first")}>Сначала свежие, потом весь пул</Pill>
              <Pill active={v.sourceStrategy === "pool"} onClick={() => set("sourceStrategy", "pool")}>Весь пул равномерно</Pill>
              <Pill active={v.sourceStrategy === "fresh_only"} onClick={() => set("sourceStrategy", "fresh_only")}>Только новые загрузки</Pill>
            </div>
          </Field>

          <Field label="Темп нарезки" hint="длина одного кадра">
            <div className="flex flex-wrap gap-2">
              <Pill active={v.pace === "calm"} onClick={() => set("pace", "calm")}>Спокойный · 2.5–5с</Pill>
              <Pill active={v.pace === "normal"} onClick={() => set("pace", "normal")}>Обычный · 1.6–3.6с</Pill>
              <Pill active={v.pace === "fast"} onClick={() => set("pace", "fast")}>Динамичный · 1–2.4с</Pill>
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Формат">
              <div className="flex gap-2">
                {(["9:16", "4:5", "1:1"] as const).map((a) => (
                  <Pill key={a} active={v.aspect === a} onClick={() => set("aspect", a)}>{a}</Pill>
                ))}
              </div>
            </Field>
            <Field label="Умное кадрирование">
              <div className="flex gap-2">
                <Pill active={v.smartCrop} onClick={() => set("smartCrop", true)}>Следить за лицом</Pill>
                <Pill active={!v.smartCrop} onClick={() => set("smartCrop", false)}>По центру</Pill>
              </div>
            </Field>
          </div>

          <Field label="Субтитры (вшиваются по озвучке)">
            <div className="flex flex-wrap gap-2">
              {SUBTITLE_STYLES.map((s) => (
                <Pill key={s.value} active={v.subtitleStyle === s.value} onClick={() => set("subtitleStyle", s.value)}>
                  <span className={s.cls}>{s.label}</span>
                </Pill>
              ))}
            </div>
          </Field>

          <Field label="Фоновая музыка" hint={v.bgmKeys.length ? `ротация: ${v.bgmKeys.length}` : "без музыки"}>
            {bgm.length === 0 ? (
              <p className="text-xs text-text-tertiary">Библиотека пуста — загрузите треки в разделе Uniquify.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {bgm.map((t) => (
                  <Pill key={t.key} active={v.bgmKeys.includes(t.key)} onClick={() => set("bgmKeys", toggle(v.bgmKeys, t.key))}>
                    ♪ {t.name}
                  </Pill>
                ))}
              </div>
            )}
          </Field>
        </Section>

        {/* ── 2. AI script & voice ─────────────────────────────────────────── */}
        <Section n={2} title="AI-сценарий и озвучка" hint="Для каждого ролика пишется новый текст и новая озвучка">
          {meta && (!meta.aiKeys.openrouter || !meta.aiKeys.fishAudio) && (
            <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning space-y-0.5">
              {!meta.aiKeys.fishAudio && <div>• Ключ Fish Audio не задан на сервере — без него озвучка невозможна.</div>}
              {!meta.aiKeys.openrouter && <div>• Ключ OpenRouter не задан — сценарии будут шаблонными.</div>}
              <div>Задайте ключи: Админ → Настройки → «Провайдеры AI».</div>
            </div>
          )}
          <Field label="О товаре / теме" hint="фишки, польза, аудитория">
            <textarea rows={3} className={cn(inputCls, "resize-none")} value={v.productInfo ?? ""}
              onChange={(e) => set("productInfo", e.target.value)}
              placeholder="Беспроводная плойка: локоны за 5 минут, керамика не портит волосы, заряда на неделю…" />
          </Field>

          <Field label="Подачи (чередуются от ролика к ролику)">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {SCRIPT_STYLES.map((s) => (
                <Pill key={s.id} active={v.scriptStyles.includes(s.id)}
                  onClick={() => {
                    const next = toggle(v.scriptStyles, s.id);
                    if (next.length) set("scriptStyles", next);
                  }}>
                  <div>{s.label}</div>
                  <div className="text-2xs font-normal text-text-tertiary">{s.desc}</div>
                </Pill>
              ))}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Призыв к действию">
              <div className="flex flex-wrap gap-2">
                <Pill active={v.ctaType === "article"} onClick={() => set("ctaType", "article")}>Артикул WB/Ozon</Pill>
                <Pill active={v.ctaType === "direct"} onClick={() => set("ctaType", "direct")}>Слово в директ</Pill>
                <Pill active={v.ctaType === "auto"} onClick={() => set("ctaType", "auto")}>Авто</Pill>
              </div>
            </Field>
            {v.ctaType === "direct" && (
              <Field label="Кодовое слово">
                <input className={cn(inputCls, "font-mono uppercase")} value={v.directWord ?? ""}
                  onChange={(e) => set("directWord", e.target.value.toUpperCase())} placeholder="ХОЧУ" />
              </Field>
            )}
          </div>

          <Field label="Голоса (чередуются)" hint={v.voiceIds.length ? `${v.voiceIds.length} в ротации` : "голос по умолчанию"}>
            <div className="grid gap-2 sm:grid-cols-2">
              {(meta?.voices ?? []).map((voice) => (
                <Pill key={voice.id} active={v.voiceIds.includes(voice.id)} onClick={() => set("voiceIds", toggle(v.voiceIds, voice.id))}>
                  <div className="flex items-center gap-1.5">
                    <span>{voice.gender === "female" ? "♀" : "♂"}</span>
                    <span>{voice.name}</span>
                  </div>
                  <div className="text-2xs font-normal text-text-tertiary line-clamp-1">{voice.description}</div>
                </Pill>
              ))}
            </div>
          </Field>
          <Field label="Скорость речи">
            <Range value={v.voiceSpeed} min={0.8} max={1.3} step={0.05} onChange={(n) => set("voiceSpeed", n)} suffix="×" />
          </Field>
        </Section>

        {/* ── 3. Uniquify ───────────────────────────────────────────────────── */}
        <Section n={3} title="Уникализация" hint="Каждый ролик размножается в N уникальных копий — по одной на телефон">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Сила уникализации">
              <div className="flex gap-2">
                <Pill active={v.stealthLevel === "maximum"} onClick={() => set("stealthLevel", "maximum")}>Максимальная</Pill>
                <Pill active={v.stealthLevel === "standard"} onClick={() => set("stealthLevel", "standard")}>Стандартная</Pill>
              </div>
            </Field>
            <Field label="Копий из одного ролика" hint={v.variantsPerMontage ? undefined : `авто = ${eligible || "N"} (по числу телефонов)`}>
              <div className="flex items-center gap-2">
                <Pill active={!v.variantsPerMontage} onClick={() => set("variantsPerMontage", null)}>Авто</Pill>
                <input type="number" min={1} max={50} className={cn(inputCls, "w-24")}
                  value={v.variantsPerMontage ?? ""} placeholder="—"
                  onChange={(e) => set("variantsPerMontage", e.target.value ? Math.max(1, Math.min(50, Number(e.target.value))) : null)} />
              </div>
            </Field>
          </div>
          <p className="text-xs text-text-tertiary">
            Сюжет, озвучка и субтитры сохраняются; меняются кадрирование, цвет, движение камеры, акустический отпечаток и метаданные файла.
          </p>
        </Section>

        {/* ── 4. Publishing ─────────────────────────────────────────────────── */}
        <Section n={4} title="Публикация через ферму телефонов" hint="Каждый телефон в каждое окно получает свою копию">
          <Field label="Какие телефоны">
            <div className="flex flex-wrap gap-2">
              <Pill active={targetMode === "all"} onClick={() => setTargetMode("all")}>Все телефоны фермы</Pill>
              <Pill active={targetMode === "group"} onClick={() => setTargetMode("group")}>Группа</Pill>
              <Pill active={targetMode === "accounts"} onClick={() => setTargetMode("accounts")}>Выбрать аккаунты</Pill>
            </div>
          </Field>
          {targetMode === "group" && (
            <select className={inputCls} value={v.accountGroupId ?? ""} onChange={(e) => set("accountGroupId", e.target.value || null)}>
              <option value="">— выберите группу —</option>
              {meta?.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          {targetMode === "accounts" && (
            <AccountPicker
              accounts={allDeviceAccounts}
              selected={v.socialAccountIds}
              onChange={(ids) => set("socialAccountIds", ids)}
              loading={previewing && !preview}
            />
          )}

          <Field label="Платформы" hint={v.platforms.length ? undefined : "все"}>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <Pill key={p.id} active={v.platforms.includes(p.id)} onClick={() => set("platforms", toggle(v.platforms, p.id))}>{p.label}</Pill>
              ))}
            </div>
          </Field>

          <Field label="Окна публикации" hint={`${windows} в день`}>
            <div className="flex flex-wrap items-center gap-2">
              {v.publishTimes.map((t) => (
                <span key={t} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500/15 px-2.5 py-1.5 font-mono text-sm text-brand-400">
                  {t}
                  <button type="button" className="text-brand-400/60 hover:text-danger" aria-label={`Удалить ${t}`}
                    onClick={() => set("publishTimes", v.publishTimes.filter((x) => x !== t))}>×</button>
                </span>
              ))}
              <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} className={cn(inputCls, "w-28")} />
              <Button size="sm" variant="outline" onClick={() => {
                if (newTime && !v.publishTimes.includes(newTime)) set("publishTimes", [...v.publishTimes, newTime].sort());
              }}>+ окно</Button>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {TIME_PRESETS.map((p) => (
                <button key={p.label} type="button" className="text-2xs text-text-tertiary underline-offset-2 hover:text-brand-400 hover:underline"
                  onClick={() => set("publishTimes", p.times)}>{p.label}: {p.times.join(", ")}</button>
              ))}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Часовой пояс">
              <select className={inputCls} value={v.timezone} onChange={(e) => set("timezone", e.target.value)}>
                {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </Field>
            <Field label="Случайный сдвиг окна">
              <Range value={v.jitterMinutes} min={0} max={60} step={5} onChange={(n) => set("jitterMinutes", n)} suffix="м" />
            </Field>
            <Field label="Пауза между телефонами">
              <Range value={v.staggerMinutes} min={1} max={60} onChange={(n) => set("staggerMinutes", n)} suffix="м" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Шаблон подписи" hint="пусто = AI-подпись к каждой копии">
              <input className={inputCls} value={v.captionTemplate ?? ""} onChange={(e) => set("captionTemplate", e.target.value)}
                placeholder="Оставьте пустым — AI напишет свою подпись" />
            </Field>
            <Field label="Хэштеги">
              <input className={inputCls} value={hashtagInput} onChange={(e) => setHashtagInput(e.target.value)} placeholder="#находки #wb" />
            </Field>
          </div>

          <details className="group rounded-lg bg-surface-2/50 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-text-secondary">Дополнительно</summary>
            <div className="grid gap-4 pt-3 sm:grid-cols-3">
              <Field label="Мин. health аккаунта">
                <Range value={v.minHealth} min={0} max={100} step={5} onChange={(n) => set("minHealth", n)} />
              </Field>
              <Field label="Запас готовых окон">
                <Range value={v.bufferWindows} min={1} max={6} onChange={(n) => set("bufferWindows", n)} />
              </Field>
              <Field label="Монтажей параллельно">
                <Range value={v.maxParallelBatches} min={1} max={5} onChange={(n) => set("maxParallelBatches", n)} />
              </Field>
            </div>
          </details>
        </Section>

        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button variant="primary" size="lg" loading={saving} onClick={submit}>{submitLabel}</Button>
          {onCancel && <Button variant="ghost" size="lg" onClick={onCancel}>Отмена</Button>}
        </div>
      </div>

      {/* ── Live summary ─────────────────────────────────────────────────────── */}
      <aside className="h-fit space-y-3">
        <Card className="border-brand-500/30">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-text-primary">Как это будет работать</h4>
              {previewing && <LoadingSpinner size={14} />}
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
              <Stat value={eligible} label="телефонов готово" tone={eligible ? "ok" : "bad"} />
              <Stat value={windows} label="окон в день" />
              <Stat value={windows} label="роликов в день" />
              <Stat value={postsPerDay} label="постов в день" tone="brand" />
            </div>
            <ol className="space-y-1.5 text-xs text-text-secondary">
              <li>1. Берёт {v.montageMode === "single" ? "1 исходник" : `${v.sourcesPerMontage} исходника`} из «{project?.name ?? "проекта"}»</li>
              <li>2. Пишет новый сценарий и озвучивает</li>
              <li>3. Монтирует под озвучку + субтитры</li>
              <li>4. Делает {v.variantsPerMontage ?? (eligible || "N")} уникальных копий</li>
              <li>5. В {v.publishTimes.join(", ") || "—"} публикует по копии на каждый телефон</li>
            </ol>
            <div className="text-2xs text-text-tertiary">
              Исходников: {preview?.sources.total ?? 0}
              {v.sourceStrategy === "fresh_only" && preview && ` — хватит на ~${Math.floor(preview.sources.total / (v.montageMode === "single" ? 1 : v.sourcesPerMontage))} роликов`}
            </div>
            {preview?.windowError && <p className="rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger">{preview.windowError}</p>}
            {preview?.warnings.map((w) => <p key={w} className="rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning">{w}</p>)}
          </CardContent>
        </Card>

        {deviceAccounts.length > 0 && (
          <Card>
            <CardContent className="p-4 space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Телефоны в охвате</h4>
              <ul className="max-h-64 space-y-1 overflow-auto pr-1">
                {deviceAccounts.slice(0, 50).map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-text-secondary">{a.accountName}</span>
                    {a.ok
                      ? <Badge variant="success">готов</Badge>
                      : <span className="truncate text-2xs text-danger" title={a.blockers.join(", ")}>{a.blockers[0]}</span>}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
        {preview && allDeviceAccounts.length === 0 && (
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
            Нет аккаунтов с методом «телефон». Привяжите аккаунты к телефонам в разделе Account Farm.
          </p>
        )}
      </aside>
    </div>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: "ok" | "bad" | "brand" }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2 py-2">
      <div className={cn(
        "text-xl font-semibold tabular-nums",
        tone === "ok" && "text-success", tone === "bad" && "text-danger", tone === "brand" && "text-brand-400",
        !tone && "text-text-primary",
      )}>{value}</div>
      <div className="text-2xs text-text-tertiary">{label}</div>
    </div>
  );
}

function AccountPicker({ accounts, selected, onChange, loading }: {
  accounts: AutopilotPreview["accounts"]; selected: string[]; onChange: (ids: string[]) => void; loading: boolean;
}) {
  const sorted = useMemo(() => [...accounts].sort((a, b) => Number(b.ok) - Number(a.ok)), [accounts]);
  if (loading) return <div className="py-3"><LoadingSpinner size={16} /></div>;
  if (accounts.length === 0) return <p className="text-xs text-text-tertiary">Нет аккаунтов с методом «телефон».</p>;
  return (
    <div className="space-y-2">
      <div className="flex gap-3 text-2xs">
        <button type="button" className="text-brand-400 hover:underline" onClick={() => onChange(accounts.filter((a) => a.ok).map((a) => a.id))}>выбрать готовые</button>
        <button type="button" className="text-text-tertiary hover:underline" onClick={() => onChange([])}>снять все</button>
      </div>
      <div className="grid max-h-56 gap-1 overflow-auto sm:grid-cols-2">
        {sorted.map((a) => (
          <label key={a.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-xs", selected.includes(a.id) ? "bg-brand-500/10" : "bg-surface-2/60")}>
            <input type="checkbox" checked={selected.includes(a.id)} onChange={() => onChange(toggle(selected, a.id))} className="accent-brand-500" />
            <span className="truncate text-text-primary">{a.accountName}</span>
            <span className="text-2xs text-text-tertiary">{a.platform}</span>
            {!a.ok && <span className="ml-auto truncate text-2xs text-danger">{a.blockers[0]}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

/** Drop target fields that the selected target mode doesn't use. */
function scoped(v: AutopilotInput, mode: "all" | "group" | "accounts"): AutopilotInput {
  return {
    ...v,
    accountGroupId: mode === "group" ? v.accountGroupId : null,
    // In "accounts" mode keep the selection; preview for "all"/"group" ignores it.
    socialAccountIds: mode === "accounts" ? v.socialAccountIds : [],
    voiceSpeed: Number(v.voiceSpeed),
  };
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import * as Select from "@radix-ui/react-select";
import * as Switch from "@radix-ui/react-switch";
import { TopBar } from "@/components/layout/AppShell";
import { Button, Card, CardContent, Input, Textarea, Progress, Badge } from "@/components/ui/primitives";
import { Stepper } from "@/components/ui/composite";
import { cn } from "@/lib/utils";
import { productsApi, videosApi } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type FormData = {
  // Step 1 — Продукт
  productName: string;
  productDescription: string;
  features: string[];
  featureInput: string;
  targetAudience: string;
  brandVoice: string;
  category: string;
  price: string;
  websiteUrl: string;
  // Step 2 — Настройки видео
  videoIdea: string;
  language: string;
  style: string;
  avatar: string;
  voice: string;
  subtitlesEnabled: boolean;
  subtitleStyle: string;
  // Step 3 — Запуск
};

const DEFAULT: FormData = {
  productName: "",
  productDescription: "",
  features: [],
  featureInput: "",
  targetAudience: "",
  brandVoice: "professional",
  category: "",
  price: "",
  websiteUrl: "",
  videoIdea: "",
  language: "ru",
  style: "informative",
  avatar: "anna-v3",
  voice: "anna-ru",
  subtitlesEnabled: true,
  subtitleStyle: "tiktok",
};

const STEPS = [
  { id: 1, label: "Продукт" },
  { id: 2, label: "Настройки видео" },
  { id: 3, label: "Запуск" },
];

// ── Options ───────────────────────────────────────────────────────────────────

const LANGUAGES   = [{ value: "ru", label: "Русский" }, { value: "en", label: "English" }, { value: "de", label: "Deutsch" }];
const STYLES      = [{ value: "informative", label: "Информационный" }, { value: "storytelling", label: "Нарратив / история" }, { value: "review", label: "Обзор / рецензия" }, { value: "educational", label: "Обучающий" }, { value: "promo", label: "Рекламный" }];
const BRAND_VOICES= [{ value: "professional", label: "Профессиональный" }, { value: "friendly", label: "Дружелюбный" }, { value: "expert", label: "Экспертный" }, { value: "casual", label: "Неформальный" }, { value: "luxury", label: "Премиальный" }];
const CATEGORIES  = [{ value: "", label: "Не указана" }, { value: "tech", label: "Технологии" }, { value: "beauty", label: "Красота" }, { value: "food", label: "Еда" }, { value: "fashion", label: "Мода" }, { value: "education", label: "Образование" }, { value: "finance", label: "Финансы" }, { value: "health", label: "Здоровье" }, { value: "other", label: "Другое" }];
const AVATARS     = [{ value: "anna-v3", label: "Анна (реалистичный)" }, { value: "max-v2", label: "Макс (деловой)" }, { value: "lena-v1", label: "Лена (молодёжный)" }, { value: "none", label: "Без аватара" }];
const VOICES      = [{ value: "anna-ru", label: "Анна — RU" }, { value: "ivan-ru", label: "Иван — RU" }, { value: "emily-en", label: "Emily — EN" }];
const SUB_STYLES  = [{ value: "tiktok", label: "TikTok Bold" }, { value: "cinematic", label: "Кинематографический" }, { value: "minimal", label: "Минимальный" }, { value: "default", label: "Стандартный" }];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CreatePage() {
  const [step, setStep]       = useState(1);
  const [form, setForm]       = useState<FormData>(DEFAULT);
  const [launching, setLaunching] = useState(false);
  const [launchProgress, setLaunchProgress] = useState(0);
  const [error, setError]     = useState<string | null>(null);
  const router = useRouter();

  const set = <K extends keyof FormData>(key: K, val: FormData[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const addFeature = () => {
    const f = form.featureInput.trim();
    if (f && form.features.length < 10) {
      set("features", [...form.features, f]);
      set("featureInput", "");
    }
  };

  const removeFeature = (idx: number) => {
    set("features", form.features.filter((_, i) => i !== idx));
  };

  const canNext = () => {
    if (step === 1) return form.productName.trim().length > 0;
    if (step === 2) return form.videoIdea.trim().length >= 10;
    return true;
  };

  const handleLaunch = async () => {
    setLaunching(true);
    setError(null);
    setLaunchProgress(10);

    try {
      // 1. Создаём продукт
      setLaunchProgress(20);
      const product = await productsApi.create({
        name: form.productName,
        description: form.productDescription || undefined,
        features: form.features,
        targetAudience: form.targetAudience || undefined,
        brandVoice: form.brandVoice || undefined,
        category: form.category || undefined,
        price: form.price || undefined,
        websiteUrl: form.websiteUrl || undefined,
      });

      // 2. Создаём видео от продукта
      setLaunchProgress(50);
      const result = await videosApi.create({
        title: `${form.productName} — видео`,
        scriptPrompt: form.videoIdea,
        productId: product.id,
        avatarId: form.avatar,
        settings: {
          resolution: "1080x1920",
          fps: 30,
          language: form.language,
        },
      });

      setLaunchProgress(100);
      setTimeout(() => router.push(`/videos/${result.video.id}`), 600);
    } catch (err: any) {
      setError(err.message ?? "Ошибка при создании");
      setLaunching(false);
      setLaunchProgress(0);
    }
  };

  return (
    <>
      <TopBar title="Создать видео" />

      <main className="flex-1 p-6">
        {/* Stepper */}
        <div className="max-w-3xl mx-auto mb-8">
          <Stepper
            steps={STEPS.map((s) => ({ id: s.id, label: s.label }))}
            current={step - 1}
          />
        </div>

        {/* Step cards */}
        <div className="max-w-3xl mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14 }}
              transition={{ duration: 0.2 }}
            >
              {step === 1 && <Step1Product form={form} set={set} addFeature={addFeature} removeFeature={removeFeature} />}
              {step === 2 && <Step2VideoSettings form={form} set={set} />}
              {step === 3 && <Step3Launch form={form} launching={launching} progress={launchProgress} error={error} />}
            </motion.div>
          </AnimatePresence>

          {/* Navigation */}
          {!launching && (
            <div className="flex justify-between mt-6">
              <Button variant="ghost" size="sm" disabled={step === 1} onClick={() => setStep((s) => s - 1)}>
                ← Назад
              </Button>
              {step < 3 ? (
                <Button variant="primary" size="sm" disabled={!canNext()} onClick={() => setStep((s) => s + 1)}>
                  Далее →
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={handleLaunch} disabled={!canNext()}>
                  <RocketIcon />
                  Создать продукт и запустить
                </Button>
              )}
            </div>
          )}
        </div>
      </main>
    </>
  );
}

// ── Steps ─────────────────────────────────────────────────────────────────────

function Step1Product({ form, set, addFeature, removeFeature }: {
  form: FormData;
  set: (key: any, val: any) => void;
  addFeature: () => void;
  removeFeature: (idx: number) => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-5 pt-6 pb-6">
        <SectionHeader step={1} title="Информация о продукте" subtitle="Опишите продукт — AI создаст идею, сценарий и промты для генерации видео" />

        <Input label="Название продукта *" placeholder="Умная колонка Galaxy Home 3" value={form.productName} onChange={(e) => set("productName", e.target.value)} hint="Название будет использоваться в сценарии" />

        <Textarea label="Описание продукта" placeholder="Подробно опишите продукт: что он делает, для кого, основные преимущества…" rows={4} value={form.productDescription} onChange={(e) => set("productDescription", e.target.value)} hint="Чем подробнее — тем качественнее будет видео" />

        {/* Features */}
        <div>
          <p className="text-xs font-medium text-text-secondary mb-1.5">Ключевые характеристики ({form.features.length}/10)</p>
          <div className="flex gap-2">
            <Input placeholder="Например: Голосовой помощник AI" value={form.featureInput} onChange={(e) => set("featureInput", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFeature(); } }} />
            <Button variant="secondary" size="sm" onClick={addFeature} disabled={!form.featureInput.trim() || form.features.length >= 10}>+</Button>
          </div>
          {form.features.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {form.features.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-brand-500/10 text-brand-400 text-xs font-medium"
                >
                  {f}
                  <button onClick={() => removeFeature(i)} className="hover:text-red-400 transition-colors">&times;</button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input label="Целевая аудитория" placeholder="Молодёжь 18-35, техноэнтузиасты" value={form.targetAudience} onChange={(e) => set("targetAudience", e.target.value)} />
          <RadixSelect label="Тон бренда" value={form.brandVoice} options={BRAND_VOICES} onValueChange={(v) => set("brandVoice", v)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <RadixSelect label="Категория" value={form.category} options={CATEGORIES} onValueChange={(v) => set("category", v)} />
          <Input label="Цена" placeholder="от 9 990 ₽" value={form.price} onChange={(e) => set("price", e.target.value)} />
        </div>

        <Input label="Сайт продукта" placeholder="https://example.com/product" value={form.websiteUrl} onChange={(e) => set("websiteUrl", e.target.value)} />
      </CardContent>
    </Card>
  );
}

function Step2VideoSettings({ form, set }: { form: FormData; set: (key: any, val: any) => void }) {
  return (
    <Card>
      <CardContent className="space-y-5 pt-6 pb-6">
        <SectionHeader step={2} title="Настройки видео" subtitle="Опишите идею для видео — AI автоматически создаст сценарий, промты и сцены" />

        <Textarea
          label="Идея / задача для видео *"
          placeholder="Создай рекламный ролик для TikTok, покажи основные фишки продукта, начни с крючка-вопроса…"
          rows={4}
          value={form.videoIdea}
          onChange={(e) => set("videoIdea", e.target.value)}
          hint="Минимум 10 символов. AI сгенерирует подробный сценарий и промты на основе данных продукта"
        />

        <div className="grid grid-cols-2 gap-4">
          <RadixSelect label="Язык" value={form.language} options={LANGUAGES} onValueChange={(v) => set("language", v)} />
          <RadixSelect label="Стиль подачи" value={form.style} options={STYLES} onValueChange={(v) => set("style", v)} />
        </div>

        <div>
          <p className="text-xs font-medium text-text-secondary mb-2">Аватар</p>
          <div className="grid grid-cols-2 gap-3">
            {AVATARS.map((a) => (
              <AvatarCard key={a.value} label={a.label} selected={form.avatar === a.value} onClick={() => set("avatar", a.value)} />
            ))}
          </div>
        </div>

        <RadixSelect label="Голос" value={form.voice} options={VOICES} onValueChange={(v) => set("voice", v)} />

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-text-primary">Субтитры</p>
            <p className="text-xs text-text-tertiary mt-0.5">Автоматические субтитры на видео</p>
          </div>
          <SwitchToggle checked={form.subtitlesEnabled} onCheckedChange={(v) => set("subtitlesEnabled", v)} />
        </div>
        {form.subtitlesEnabled && (
          <div className="grid grid-cols-2 gap-3">
            {SUB_STYLES.map((s) => (
              <button
                key={s.value}
                onClick={() => set("subtitleStyle", s.value)}
                className={cn(
                  "rounded-lg border px-4 py-3 text-sm font-medium transition-all",
                  form.subtitleStyle === s.value
                    ? "border-brand-500 bg-brand-500/10 text-brand-400"
                    : "border-border bg-surface-2 text-text-secondary hover:border-brand-500/40"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Step3Launch({ form, launching, progress, error }: {
  form: FormData;
  launching: boolean;
  progress: number;
  error: string | null;
}) {
  return (
    <Card>
      <CardContent className="space-y-5 pt-6 pb-6">
        <SectionHeader step={3} title="Проверка и запуск" subtitle="Проверьте данные перед созданием" />

        {/* Product summary */}
        <div>
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">Продукт</p>
          <ul className="space-y-1.5 text-sm">
            {[
              ["Название",      form.productName || "(не задано)"],
              ["Категория",     CATEGORIES.find(c => c.value === form.category)?.label ?? "Не указана"],
              ["Тон бренда",    BRAND_VOICES.find(b => b.value === form.brandVoice)?.label ?? ""],
              ["Характеристик", form.features.length > 0 ? form.features.join(", ") : "нет"],
              ["Цена",          form.price || "не указана"],
            ].map(([k, v]) => (
              <li key={k as string} className="flex items-start justify-between gap-2 py-1 border-b border-border/50 last:border-0">
                <span className="text-text-tertiary">{k}</span>
                <span className="text-text-primary text-right font-medium max-w-[250px] truncate">{v}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Video summary */}
        <div>
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">Видео</p>
          <ul className="space-y-1.5 text-sm">
            {[
              ["Идея",     form.videoIdea?.slice(0, 80) + (form.videoIdea.length > 80 ? "…" : "") || "(не задана)"],
              ["Язык",     LANGUAGES.find(l => l.value === form.language)?.label ?? ""],
              ["Стиль",    STYLES.find(s => s.value === form.style)?.label ?? ""],
              ["Аватар",   AVATARS.find(a => a.value === form.avatar)?.label ?? ""],
              ["Субтитры", form.subtitlesEnabled ? SUB_STYLES.find(s => s.value === form.subtitleStyle)?.label ?? "" : "Нет"],
            ].map(([k, v]) => (
              <li key={k as string} className="flex items-start justify-between gap-2 py-1 border-b border-border/50 last:border-0">
                <span className="text-text-tertiary">{k}</span>
                <span className="text-text-primary text-right font-medium max-w-[250px] truncate">{v}</span>
              </li>
            ))}
          </ul>
        </div>

        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {launching && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-secondary">
                {progress < 30 ? "Создание продукта…" : progress < 80 ? "Запуск генерации видео…" : "Готово!"}
              </span>
              <span className="text-brand-400 font-medium">{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} variant="brand" size="md" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionHeader({ step, title, subtitle }: { step: number; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-500/15 text-brand-400 text-xs font-bold flex items-center justify-center ring-1 ring-brand-500/30">
        {step}
      </span>
      <div>
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        <p className="text-xs text-text-tertiary mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}

function AvatarCard({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-xl border px-4 py-3 text-sm text-left transition-all hover:border-brand-500/40 flex items-center gap-2",
        selected ? "border-brand-500 bg-brand-500/10 text-brand-400" : "border-border bg-surface-2 text-text-secondary"
      )}
    >
      <span className="w-7 h-7 rounded-full bg-surface-3 flex items-center justify-center text-base">
        🧑
      </span>
      <span className="font-medium">{label}</span>
      {selected && <CheckmarkIcon className="ml-auto text-brand-500" />}
    </button>
  );
}

function RadixSelect({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onValueChange: (v: string) => void;
}) {
  const current = options.find((o) => o.value === value)?.label ?? "Выбрать…";
  return (
    <div>
      <p className="text-xs font-medium text-text-secondary mb-1.5">{label}</p>
      <Select.Root value={value} onValueChange={onValueChange}>
        <Select.Trigger className={cn(
          "w-full flex items-center justify-between",
          "rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary",
          "hover:border-border/80 focus:outline-none focus:ring-2 focus:ring-brand-500/30 transition-all"
        )}>
          <Select.Value>{current}</Select.Value>
          <Select.Icon><ChevronIcon /></Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            className="z-50 min-w-[180px] rounded-xl border border-border bg-surface-1 shadow-elevation-3 overflow-hidden"
          >
            <Select.Viewport className="p-1">
              {options.map((o) => (
                <Select.Item
                  key={o.value}
                  value={o.value}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary rounded-lg cursor-pointer outline-none hover:bg-surface-2 data-[highlighted]:bg-surface-2"
                >
                  <Select.ItemText>{o.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

function SwitchToggle({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (v: boolean) => void }) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={cn(
        "relative inline-flex h-5 w-9 rounded-full border-2 border-transparent transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-brand-500/30",
        checked ? "bg-brand-500" : "bg-surface-3"
      )}
    >
      <Switch.Thumb className={cn(
        "block h-4 w-4 rounded-full bg-white shadow transition-transform",
        checked ? "translate-x-4" : "translate-x-0"
      )} />
    </Switch.Root>
  );
}

// Icons
function RocketIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2 -.66-2.97-2-2.97A2.01 2.01 0 0 0 4.5 16.5"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>; }
function ChevronIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><polyline points="6 9 12 15 18 9"/></svg>; }
function CheckmarkIcon({ className }: { className?: string }) { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden><polyline points="20 6 9 17 4 12"/></svg>; }

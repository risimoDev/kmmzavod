"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  LoadingSpinner,
  Card,
  CardContent,
  Input,
  EmptyState,
} from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime } from "@/lib/utils";
import {
  editorApi,
  type EditProject,
  type EditMode,
  type EditGeometry,
  type EditAspect,
  type EditAudioMode,
} from "@/lib/api";

const MODES: { value: EditMode; label: string; hint: string }[] = [
  { value: "smart_montage", label: "Интеллектуальный монтаж", hint: "Готовое видео: субтитры по речи, переходы, умный монтаж" },
  { value: "uniquify_source", label: "Нарезка под уникализацию", hint: "Сырьё для системы уникализации (без субтитров)" },
];

const GEOMETRIES: { value: EditGeometry; label: string; hint: string }[] = [
  { value: "highlights", label: "Нарезка длинного → шортсы", hint: "Из 1 длинного видео — N лучших моментов" },
  { value: "mix", label: "Микс N видео → одно", hint: "Собрать один динамичный ролик из нескольких" },
];

const ASPECTS: EditAspect[] = ["9:16", "1:1", "16:9", "4:5"];
const AUDIO: { value: EditAudioMode; label: string }[] = [
  { value: "keep", label: "Оригинальный звук" },
  { value: "replace", label: "Заменить (озвучка+музыка)" },
];
const SUBTITLE_STYLES = ["none", "tiktok", "cinematic", "minimal", "default"];

const PRESETS: { label: string; patch: Partial<EditProject> & { name: string } }[] = [
  { label: "Хайлайты из подкаста", patch: { name: "Хайлайты", mode: "smart_montage", geometry: "highlights", aspect: "9:16", subtitleStyle: "tiktok", audioMode: "keep", targetClipCount: 5, targetClipSeconds: 30 } },
  { label: "Динамичный микс", patch: { name: "Микс", mode: "smart_montage", geometry: "mix", aspect: "9:16", subtitleStyle: "tiktok", audioMode: "keep", targetClipSeconds: 25 } },
  { label: "Сырьё для уникализации", patch: { name: "Уникализация", mode: "uniquify_source", geometry: "mix", aspect: "9:16", subtitleStyle: "none", audioMode: "keep", targetClipSeconds: 30 } },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

const selectCls =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

export default function EditorProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<EditProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Full config state
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
      const { projects } = await editorApi.listProjects();
      setProjects(projects);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function applyPreset(patch: Partial<EditProject> & { name: string }) {
    if (!name.trim()) setName(patch.name);
    if (patch.mode) setMode(patch.mode);
    if (patch.geometry) setGeometry(patch.geometry);
    if (patch.aspect) setAspect(patch.aspect);
    if (patch.audioMode) setAudioMode(patch.audioMode);
    if (patch.subtitleStyle !== undefined) setSubtitleStyle(patch.subtitleStyle);
    if (patch.targetClipCount) setTargetClipCount(patch.targetClipCount);
    if (patch.targetClipSeconds) setTargetClipSeconds(patch.targetClipSeconds);
  }

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const p = await editorApi.createProject({
        name: name.trim(), mode, geometry, aspect, audioMode,
        subtitleStyle, smartCrop, useVision, targetClipCount, targetClipSeconds,
      });
      router.push(`/editor/${p.id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Умный редактор" subtitle="Интеллектуальная нарезка и монтаж" />

      <div className="flex-1 overflow-auto p-6 space-y-6">
        <Card>
          <CardContent className="p-4 space-y-4">
            <h3 className="font-semibold">Новый проект</h3>

            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <Button key={p.label} variant="outline" size="sm" onClick={() => applyPreset(p.patch)}>
                  {p.label}
                </Button>
              ))}
            </div>

            <Input placeholder="Название проекта" value={name} onChange={(e) => setName(e.target.value)} />

            {/* What to do */}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Что делаем">
                <div className="space-y-1">
                  {MODES.map((m) => (
                    <button key={m.value} type="button" onClick={() => setMode(m.value)}
                      className={`w-full text-left rounded-md border p-2 text-sm transition ${
                        mode === m.value ? "border-primary bg-primary/5" : "border-border"}`}>
                      <div className="font-medium">{m.label}</div>
                      <div className="text-xs text-muted-foreground">{m.hint}</div>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Как собираем">
                <div className="space-y-1">
                  {GEOMETRIES.map((g) => (
                    <button key={g.value} type="button" onClick={() => setGeometry(g.value)}
                      className={`w-full text-left rounded-md border p-2 text-sm transition ${
                        geometry === g.value ? "border-primary bg-primary/5" : "border-border"}`}>
                      <div className="font-medium">{g.label}</div>
                      <div className="text-xs text-muted-foreground">{g.hint}</div>
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            {/* Detailed settings */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Формат">
                <select className={selectCls} value={aspect} onChange={(e) => setAspect(e.target.value as EditAspect)}>
                  {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
              <Field label="Субтитры">
                <select className={selectCls} value={subtitleStyle} onChange={(e) => setSubtitleStyle(e.target.value)}>
                  {SUBTITLE_STYLES.map((s) => (
                    <option key={s} value={s}>{s === "none" ? "выкл" : s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Звук">
                <select className={selectCls} value={audioMode} onChange={(e) => setAudioMode(e.target.value as EditAudioMode)}>
                  {AUDIO.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </Field>
              <Field label="Длина клипа, сек">
                <Input type="number" min={3} max={180} value={targetClipSeconds}
                  onChange={(e) => setTargetClipSeconds(Number(e.target.value))} />
              </Field>
              {geometry === "highlights" && (
                <Field label="Сколько клипов">
                  <Input type="number" min={1} max={30} value={targetClipCount}
                    onChange={(e) => setTargetClipCount(Number(e.target.value))} />
                </Field>
              )}
            </div>

            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={smartCrop} onChange={(e) => setSmartCrop(e.target.checked)} />
                Умное кадрирование (следить за лицом)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={useVision} onChange={(e) => setUseVision(e.target.checked)} />
                ИИ-анализ кадра (gpt-4o, платно)
              </label>
            </div>

            <Button onClick={create} disabled={creating || !name.trim()}>
              {creating ? "Создание…" : "Создать проект"}
            </Button>
          </CardContent>
        </Card>

        {loading ? (
          <div className="flex justify-center py-12"><LoadingSpinner /></div>
        ) : projects.length === 0 ? (
          <EmptyState title="Нет проектов" description="Создайте первый проект редактора выше." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Card key={p.id} className="cursor-pointer hover:border-primary transition"
                onClick={() => router.push(`/editor/${p.id}`)}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-medium truncate">{p.name}</h4>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {p.mode === "smart_montage" ? "Монтаж" : "Уникализация"} · {p.aspect} ·{" "}
                    {p._count?.sources ?? 0} источн. · {p._count?.clips ?? 0} клип.
                  </div>
                  <div className="text-xs text-muted-foreground">{relativeTime(p.createdAt)}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

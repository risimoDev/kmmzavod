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
} from "@/lib/api";

const MODES: { value: EditMode; label: string; hint: string }[] = [
  { value: "smart_montage", label: "Интеллектуальный монтаж", hint: "Готовое видео: субтитры по речи, умный монтаж" },
  { value: "uniquify_source", label: "Нарезка под уникализацию", hint: "Сырьё для системы уникализации" },
];

const GEOMETRIES: { value: EditGeometry; label: string }[] = [
  { value: "highlights", label: "Нарезка длинного → шортсы" },
  { value: "mix", label: "Микс N видео → одно" },
];

const PRESETS: { label: string; mode: EditMode; geometry: EditGeometry; name: string }[] = [
  { label: "Хайлайты из подкаста", mode: "smart_montage", geometry: "highlights", name: "Хайлайты" },
  { label: "Микс для соцсетей", mode: "smart_montage", geometry: "mix", name: "Микс" },
  { label: "Сырьё для уникализации", mode: "uniquify_source", geometry: "mix", name: "Уникализация" },
];

export default function EditorProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<EditProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<EditMode>("smart_montage");
  const [geometry, setGeometry] = useState<EditGeometry>("highlights");

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

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const p = await editorApi.createProject({ name: name.trim(), mode, geometry });
      router.push(`/editor/${p.id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Умный редактор" subtitle="Интеллектуальная нарезка и монтаж" />

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Create */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="font-semibold">Новый проект</h3>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <Button key={p.label} variant="outline" size="sm"
                  onClick={() => { setMode(p.mode); setGeometry(p.geometry); if (!name.trim()) setName(p.name); }}>
                  {p.label}
                </Button>
              ))}
            </div>
            <Input placeholder="Название проекта" value={name}
              onChange={(e) => setName(e.target.value)} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm text-muted-foreground">Режим</label>
                <div className="mt-1 space-y-1">
                  {MODES.map((m) => (
                    <button key={m.value} onClick={() => setMode(m.value)}
                      className={`w-full text-left rounded-md border p-2 text-sm transition ${
                        mode === m.value ? "border-primary bg-primary/5" : "border-border"
                      }`}>
                      <div className="font-medium">{m.label}</div>
                      <div className="text-xs text-muted-foreground">{m.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Геометрия</label>
                <div className="mt-1 space-y-1">
                  {GEOMETRIES.map((g) => (
                    <button key={g.value} onClick={() => setGeometry(g.value)}
                      className={`w-full text-left rounded-md border p-2 text-sm transition ${
                        geometry === g.value ? "border-primary bg-primary/5" : "border-border"
                      }`}>
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <Button onClick={create} disabled={creating || !name.trim()}>
              {creating ? "Создание…" : "Создать проект"}
            </Button>
          </CardContent>
        </Card>

        {/* List */}
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

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  LoadingSpinner,
  Badge,
  Card,
  CardContent,
  Input,
  EmptyState,
} from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  editorApi,
  type EditProjectDetail,
  type EditClip,
  type EditOutput,
} from "@/lib/api";

const POLL_MS = 4000;

export default function EditorProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<EditProjectDetail | null>(null);
  const [outputs, setOutputs] = useState<EditOutput[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const p = await editorApi.getProject(id);
    setProject(p);
    if (p.status === "completed") {
      const { outputs } = await editorApi.outputs(id);
      setOutputs(outputs);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Poll while a background job runs.
  useEffect(() => {
    if (!project) return;
    if (project.status !== "analyzing" && project.status !== "rendering") return;
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [project, load]);

  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) await editorApi.uploadSource(id, f);
      await load();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function analyze() {
    setBusy(true);
    try { await editorApi.analyze(id); await load(); } finally { setBusy(false); }
  }

  async function render() {
    setBusy(true);
    try { await editorApi.render(id); await load(); } finally { setBusy(false); }
  }

  async function toggleClip(clip: EditClip) {
    const updated = await editorApi.updateClip(id, clip.id, { included: !clip.included });
    setProject((p) => p && { ...p, clips: p.clips.map((c) => c.id === clip.id ? { ...c, included: updated.included } : c) });
  }

  async function renameClip(clip: EditClip, title: string) {
    await editorApi.updateClip(id, clip.id, { title });
  }

  if (loading || !project) {
    return <div className="flex justify-center py-20"><LoadingSpinner /></div>;
  }

  const includedCount = project.clips.filter((c) => c.included).length;
  const isWorking = project.status === "analyzing" || project.status === "rendering";

  return (
    <div className="flex flex-col h-full">
      <TopBar title={project.name}
        subtitle={`${project.mode === "smart_montage" ? "Интеллектуальный монтаж" : "Нарезка под уникализацию"} · ${project.aspect}`} />

      <div className="flex-1 overflow-auto p-6 space-y-6">
        <div className="flex items-center gap-3">
          <StatusBadge status={project.status} />
          <Button variant="ghost" size="sm" onClick={() => router.push("/editor")}>← К проектам</Button>
          {project.error && <span className="text-sm text-destructive">{project.error}</span>}
        </div>

        {/* What will happen */}
        <div className="flex flex-wrap gap-2">
          <Badge variant="default">{project.geometry === "highlights" ? "Хайлайты" : "Микс"}</Badge>
          <Badge variant="default">{project.aspect}</Badge>
          <Badge variant={project.subtitleStyle !== "none" ? "brand" : "outline"}>
            {project.subtitleStyle !== "none" ? `Субтитры: ${project.subtitleStyle}` : "Без субтитров"}
          </Badge>
          <Badge variant="default">
            {project.audioMode === "keep" ? "Ориг. звук" : "Озвучка+музыка"}
          </Badge>
          <Badge variant="outline">~{Math.round(Number(project.targetClipSeconds))}с</Badge>
          {project.geometry === "highlights" && (
            <Badge variant="outline">{project.targetClipCount} клип.</Badge>
          )}
          {project.smartCrop && <Badge variant="outline">smart-crop</Badge>}
        </div>

        {/* Sources + analyze */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Источники ({project.sources.length})</h3>
              <div className="flex gap-2">
                <input ref={fileRef} type="file" accept="video/*" multiple hidden
                  onChange={(e) => onUpload(e.target.files)} />
                <Button variant="secondary" size="sm" disabled={uploading || isWorking}
                  onClick={() => fileRef.current?.click()}>
                  {uploading ? "Загрузка…" : "+ Видео"}
                </Button>
                <Button size="sm" disabled={busy || isWorking || project.sources.length === 0}
                  onClick={analyze}>
                  {project.status === "analyzing" ? "Анализ…" : "Анализировать"}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {project.sources.map((s, i) => (
                <Badge key={s.id} variant="default">
                  #{i + 1} {s.durationSec ? `${Math.round(Number(s.durationSec))}s` : "…"}
                  {s.width ? ` · ${s.width}×${s.height}` : ""}
                </Badge>
              ))}
              {project.sources.length === 0 && (
                <span className="text-sm text-muted-foreground">Загрузите одно или несколько видео.</span>
              )}
            </div>
          </CardContent>
        </Card>

        {isWorking && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <LoadingSpinner /> {project.status === "analyzing" ? "Анализируем источники…" : "Рендерим клипы…"}
          </div>
        )}

        {/* Storyboard */}
        {project.clips.length > 0 && project.status !== "completed" && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Раскадровка ({includedCount}/{project.clips.length} выбрано)</h3>
                <Button size="sm" disabled={busy || isWorking || includedCount === 0} onClick={render}>
                  Рендерить выбранные
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {project.clips.map((c) => (
                  <div key={c.id}
                    className={`rounded-lg border p-3 space-y-2 transition ${
                      c.included ? "border-primary/60" : "border-border opacity-50"
                    }`}>
                    {c.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.thumbnailUrl} alt={c.title}
                        className="w-full aspect-[9/16] object-cover rounded-md bg-muted" />
                    ) : (
                      <div className="w-full aspect-[9/16] rounded-md bg-muted flex items-center justify-center text-xs text-muted-foreground">
                        нет превью
                      </div>
                    )}
                    <Input defaultValue={c.title}
                      onBlur={(e) => renameClip(c, e.target.value)} className="text-sm" />
                    {c.transcriptSnippet && (
                      <p className="text-xs text-muted-foreground line-clamp-2">“{c.transcriptSnippet}”</p>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        score {Number(c.score).toFixed(2)}
                      </span>
                      <Button variant={c.included ? "secondary" : "primary"} size="sm"
                        onClick={() => toggleClip(c)}>
                        {c.included ? "Убрать" : "Вернуть"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Outputs */}
        {project.status === "completed" && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Готовые клипы ({outputs.length})</h3>
                {project.mode === "uniquify_source" && (
                  <Button size="sm" variant="secondary" onClick={() => router.push("/uniquify")}>
                    → В уникализацию
                  </Button>
                )}
              </div>
              {outputs.length === 0 ? (
                <EmptyState title="Нет выходов" description="Клипы ещё обрабатываются или рендер не дал результатов." />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {outputs.map((o) => (
                    <div key={o.id} className="rounded-lg border p-3 space-y-2">
                      {o.url ? (
                        <video src={o.url} controls poster={o.thumbnailUrl ?? undefined}
                          className="w-full rounded-md bg-black" />
                      ) : (
                        <div className="w-full aspect-video bg-muted rounded-md" />
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium truncate">{o.title}</span>
                        {o.url && (
                          <a href={o.url} download className="text-xs text-primary hover:underline">
                            Скачать
                          </a>
                        )}
                      </div>
                      {o.sourceVideoId && (
                        <Badge variant="outline">в источниках уникализации</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

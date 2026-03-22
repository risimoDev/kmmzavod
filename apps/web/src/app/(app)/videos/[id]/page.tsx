"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import { Button, Progress, Card, CardContent, LoadingSpinner } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDuration, relativeTime } from "@/lib/utils";
import { videosApi, getAccessToken, type VideoDetail } from "@/lib/api";
import { useVideoProgress, type ProgressEvent } from "@/hooks/useVideoProgress";

const STAGE_LABELS: Record<string, string> = {
  pipeline: "Запуск",
  "gpt-script": "Генерация сценария",
  "heygen-render": "Рендер аватара",
  "runway-clip": "Генерация B-roll",
  "image-gen": "Генерация изображений",
  "kling-clip": "Генерация клипа",
  processing: "Обработка сцен",
  composing: "Композиция видео",
  "video-compose": "Финализация",
  "pipeline-state": "Проверка готовности",
  completed: "Готово",
  failed: "Ошибка",
};

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isProcessing = video != null && ["pending", "processing", "composing"].includes(video.status);
  const sse = useVideoProgress(id, isProcessing);

  const loadVideo = useCallback(() => {
    videosApi.get(id).then(setVideo).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!getAccessToken()) { router.replace("/login"); return; }
    loadVideo();
  }, [id, router, loadVideo]);

  // Автоматически перезагружаем данные при завершении
  useEffect(() => {
    if (sse.isComplete || sse.isFailed) {
      const timer = setTimeout(loadVideo, 1500);
      return () => clearTimeout(timer);
    }
  }, [sse.isComplete, sse.isFailed, loadVideo]);

  if (loading) return (<><TopBar title="Видео" /><main className="flex-1 flex items-center justify-center"><LoadingSpinner size={32} /></main></>);
  if (error || !video) return (<><TopBar title="Видео" /><main className="flex-1 flex flex-col items-center justify-center gap-4"><p className="text-text-secondary text-sm">{error ?? "Видео не найдено"}</p><Button variant="outline" size="sm" onClick={() => router.back()}>Назад</Button></main></>);

  const scenes = video.job?.scenes ?? [];
  const events = video.job?.events ?? [];

  // Используем SSE-прогресс если обрабатывается, иначе — из сцен
  const done = scenes.filter((s) => s.status === "completed").length;
  const staticPct = scenes.length > 0 ? Math.round((done / scenes.length) * 100) : 0;
  const livePct = isProcessing && sse.progress > 0 ? sse.progress : staticPct;
  const pct = video.status === "completed" ? 100 : livePct;

  // Объединяем события из SSE с сохранёнными в БД
  const allEvents = [
    ...events.map((e) => ({
      key: `db-${e.id}`,
      time: new Date(e.createdAt).toLocaleTimeString("ru-RU"),
      stage: e.stage,
      status: e.status,
      message: e.message,
    })),
    ...sse.events.map((e, i) => ({
      key: `sse-${i}`,
      time: new Date(e.timestamp).toLocaleTimeString("ru-RU"),
      stage: e.stage,
      status: e.status,
      message: e.message,
    })),
  ];

  return (
    <>
      <TopBar title={video.title} actions={<div className="flex items-center gap-2"><StatusBadge status={video.status as any} /><Button variant="outline" size="sm" onClick={() => router.back()}>Назад</Button></div>} />
      <main className="flex-1 overflow-y-auto p-6 space-y-6 animate-slide-up">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card><CardContent className="py-3 px-4"><p className="text-xs text-text-tertiary">Статус</p><StatusBadge status={video.status as any} /></CardContent></Card>
          <Card><CardContent className="py-3 px-4"><p className="text-xs text-text-tertiary">Длительность</p><p className="text-lg font-bold text-text-primary">{video.durationSec ? formatDuration(video.durationSec) : "\u2014"}</p></CardContent></Card>
          <Card><CardContent className="py-3 px-4"><p className="text-xs text-text-tertiary">Кредиты</p><p className="text-lg font-bold text-text-primary">{video.creditsUsed}</p></CardContent></Card>
          <Card><CardContent className="py-3 px-4"><p className="text-xs text-text-tertiary">Создано</p><p className="text-sm font-medium text-text-primary">{relativeTime(video.createdAt)}</p></CardContent></Card>
        </div>

        {/* Прогресс-бар */}
        {(isProcessing || scenes.length > 0) && (
          <div className="rounded-xl border border-border bg-surface-1 p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-semibold text-text-primary">Прогресс</p>
                {isProcessing && sse.stage && (
                  <p className="text-xs text-text-tertiary mt-0.5">
                    {STAGE_LABELS[sse.stage] ?? sse.stage}
                    {sse.message ? ` — ${sse.message}` : ""}
                  </p>
                )}
              </div>
              <span className="text-xs font-medium text-text-tertiary">{pct}%</span>
            </div>
            <div className="relative h-2.5 rounded-full bg-surface-2 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-brand transition-all duration-700 ease-out"
                style={{ width: `${pct}%` }}
              />
              {isProcessing && pct < 100 && (
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-brand/30 animate-pulse"
                  style={{ width: `${Math.min(pct + 5, 100)}%` }}
                />
              )}
            </div>
          </div>
        )}

        {/* Таблица сцен */}
        {scenes.length > 0 && (<div><p className="text-sm font-semibold text-text-primary mb-3">Сцены</p><div className="rounded-xl border border-border overflow-hidden"><table className="w-full text-sm"><thead><tr className="bg-surface-1 text-text-tertiary text-xs uppercase tracking-wider"><th className="text-left py-2.5 px-4 font-medium">#</th><th className="text-left py-2.5 px-4 font-medium">Тип</th><th className="text-left py-2.5 px-4 font-medium">Статус</th><th className="text-left py-2.5 px-4 font-medium">Длит.</th></tr></thead><tbody>{scenes.map((s) => (<tr key={s.id} className="border-t border-border"><td className="py-2.5 px-4 text-text-primary font-medium">{s.sceneIndex + 1}</td><td className="py-2.5 px-4 text-text-secondary">{s.type}</td><td className="py-2.5 px-4"><StatusBadge status={s.status as any} /></td><td className="py-2.5 px-4 text-text-secondary">{s.durationSec ? s.durationSec + "\u0441" : "\u2014"}</td></tr>))}</tbody></table></div></div>)}

        {/* Лог событий (БД + SSE) */}
        {allEvents.length > 0 && (<div><p className="text-sm font-semibold text-text-primary mb-3">Лог</p><div className="rounded-xl border border-border bg-surface-1 p-4 space-y-2 max-h-80 overflow-y-auto">{allEvents.map((e) => (<div key={e.key} className="flex items-start gap-3 text-xs"><span className="text-text-tertiary whitespace-nowrap">{e.time}</span><StatusBadge status={e.status as any} /><span className="text-text-secondary"><span className="font-medium text-text-primary">{STAGE_LABELS[e.stage] ?? e.stage}</span>{e.message && (" \u2014 " + e.message)}</span></div>))}</div></div>)}

        {allEvents.length === 0 && scenes.length === 0 && (<div className="rounded-xl border border-border bg-surface-1 p-8 text-center"><p className="text-text-tertiary text-sm">Данные о сценах пока отсутствуют</p></div>)}
      </main>
    </>
  );
}
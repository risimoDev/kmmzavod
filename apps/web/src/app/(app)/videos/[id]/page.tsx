"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import { Button, Progress, Card, CardContent, LoadingSpinner } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDuration, relativeTime } from "@/lib/utils";
import { videosApi, getAccessToken, type VideoDetail } from "@/lib/api";

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getAccessToken()) { router.replace("/login"); return; }
    videosApi.get(id).then(setVideo).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [id, router]);

  if (loading) return (<><TopBar title="Видео" /><main className="flex-1 flex items-center justify-center"><LoadingSpinner size={32} /></main></>);
  if (error || !video) return (<><TopBar title="Видео" /><main className="flex-1 flex flex-col items-center justify-center gap-4"><p className="text-text-secondary text-sm">{error ?? "Видео не найдено"}</p><Button variant="outline" size="sm" onClick={() => router.back()}>Назад</Button></main></>);

  const scenes = video.job?.scenes ?? [];
  const events = video.job?.events ?? [];
  const done = scenes.filter((s) => s.status === "completed").length;
  const pct = scenes.length > 0 ? Math.round((done / scenes.length) * 100) : 0;

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
        {scenes.length > 0 && (<div className="rounded-xl border border-border bg-surface-1 p-5"><div className="flex items-center justify-between mb-3"><p className="text-sm font-semibold text-text-primary">Прогресс</p><span className="text-xs text-text-tertiary">{done}/{scenes.length} сцен</span></div><Progress value={pct} showLabel size="md" variant="brand" /></div>)}
        {scenes.length > 0 && (<div><p className="text-sm font-semibold text-text-primary mb-3">Сцены</p><div className="rounded-xl border border-border overflow-hidden"><table className="w-full text-sm"><thead><tr className="bg-surface-1 text-text-tertiary text-xs uppercase tracking-wider"><th className="text-left py-2.5 px-4 font-medium">#</th><th className="text-left py-2.5 px-4 font-medium">Тип</th><th className="text-left py-2.5 px-4 font-medium">Статус</th><th className="text-left py-2.5 px-4 font-medium">Длит.</th></tr></thead><tbody>{scenes.map((s) => (<tr key={s.id} className="border-t border-border"><td className="py-2.5 px-4 text-text-primary font-medium">{s.sceneIndex + 1}</td><td className="py-2.5 px-4 text-text-secondary">{s.type}</td><td className="py-2.5 px-4"><StatusBadge status={s.status as any} /></td><td className="py-2.5 px-4 text-text-secondary">{s.durationSec ? s.durationSec + "\u0441" : "\u2014"}</td></tr>))}</tbody></table></div></div>)}
        {events.length > 0 && (<div><p className="text-sm font-semibold text-text-primary mb-3">Лог</p><div className="rounded-xl border border-border bg-surface-1 p-4 space-y-2 max-h-80 overflow-y-auto">{events.map((e) => (<div key={e.id} className="flex items-start gap-3 text-xs"><span className="text-text-tertiary whitespace-nowrap">{new Date(e.createdAt).toLocaleTimeString("ru-RU")}</span><StatusBadge status={e.status as any} /><span className="text-text-secondary"><span className="font-medium text-text-primary">{e.stage}</span>{e.message && (" \u2014 " + e.message)}</span></div>))}</div></div>)}
        {scenes.length === 0 && events.length === 0 && (<div className="rounded-xl border border-border bg-surface-1 p-8 text-center"><p className="text-text-tertiary text-sm">Данные о сценах пока отсутствуют</p></div>)}
      </main>
    </>
  );
}
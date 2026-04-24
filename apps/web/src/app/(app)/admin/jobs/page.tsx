"use client";

import { useEffect, useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { Button, Badge, Card, CardContent } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { adminApi, type AdminJob, type AdminJobDetail, type Pagination } from "@/lib/admin-api";
import { relativeTime, cn } from "@/lib/utils";

const STATUS_OPTIONS = ["", "pending", "running", "processing", "composing", "completed", "failed", "cancelled"];

const SCENE_TYPE_COLOR: Record<string, string> = {
  avatar: "text-brand-400",
  clip:   "text-info",
  image:  "text-warning",
  text:   "text-text-secondary",
};

export default function AdminJobsPage() {
  const [jobs, setJobs]             = useState<AdminJob[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0 });
  const [loading, setLoading]       = useState(true);
  const [status, setStatus]         = useState("failed");
  const [page, setPage]             = useState(1);
  const [detailJob, setDetailJob]   = useState<AdminJobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionId, setActionId]     = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    adminApi.getJobs({ page, status: status || undefined })
      .then(res => { setJobs(res.data); setPagination(res.pagination); })
      .finally(() => setLoading(false));
  }, [page, status]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setDetailJob(null);
    adminApi.getJob(id)
      .then(setDetailJob)
      .finally(() => setDetailLoading(false));
  };

  const handleRetry = async (id: string) => {
    setActionId(id);
    try { await adminApi.retryJob(id); load(); }
    finally { setActionId(null); }
  };

  const handleRecompose = async (id: string) => {
    setActionId(id);
    try { await adminApi.recomposeJob(id); load(); }
    catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Ошибка пересборки: ${msg}`);
    }
    finally { setActionId(null); }
  };

  const handleCancel = async (id: string) => {
    setActionId(id);
    try { await adminApi.cancelJob(id); load(); }
    finally { setActionId(null); }
  };

  const totalPages = Math.ceil(pagination.total / pagination.limit);

  return (
    <div className="p-6 space-y-4">
      {/* Status filters */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_OPTIONS.map(s => (
          <button key={s || "all"} onClick={() => { setStatus(s); setPage(1); }}
            className={cn(
              "h-7 px-3 rounded-md text-xs font-medium transition-colors border",
              status === s
                ? "bg-brand-500/15 text-brand-400 border-brand-500/30"
                : "bg-surface-1 text-text-tertiary border-border hover:text-text-secondary hover:bg-surface-2"
            )}>
            {s || "Все"}
          </button>
        ))}
        <span className="ml-auto text-xs text-text-tertiary">{pagination.total.toLocaleString()} задач</span>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-1">
                  {["Задача", "Тенант", "Видео", "Сцен", "Кредиты", "Статус", "Создана", "Действия"].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs text-text-tertiary font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {loading && jobs.length === 0
                    ? Array.from({ length: 6 }).map((_, i) => (
                        <tr key={i} className="border-b border-border/30">
                          {Array.from({ length: 8 }).map((_, j) => (
                            <td key={j} className="px-4 py-3"><div className="h-3 rounded bg-surface-2 animate-pulse w-20" /></td>
                          ))}
                        </tr>
                      ))
                    : jobs.map(j => (
                        <motion.tr key={j.id} layout
                          className="border-b border-border/30 last:border-0 hover:bg-surface-1 transition-colors">
                          <td className="px-4 py-3">
                            <button className="text-xs font-mono text-brand-400 hover:underline"
                              onClick={() => openDetail(j.id)}>
                              {j.id.slice(0, 8)}…
                            </button>
                          </td>
                          <td className="px-4 py-3 text-xs text-text-secondary">{j.tenant.name}</td>
                          <td className="px-4 py-3 text-xs text-text-secondary max-w-[140px] truncate">
                            {j.video?.title ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-xs tabular-nums text-text-tertiary">{j._count.scenes}</td>
                          <td className="px-4 py-3 text-xs tabular-nums text-text-secondary">{j.creditsUsed}</td>
                          <td className="px-4 py-3"><StatusBadge status={j.status} /></td>
                          <td className="px-4 py-3 text-xs text-text-tertiary whitespace-nowrap">
                            {relativeTime(j.createdAt)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1.5">
                              {(j.status === "failed" || j.status === "cancelled") && (
                                <Button variant="ghost" size="xs"
                                  title={j._count.scenes > 0 ? "Возобновить с точки сбоя" : "Полный перезапуск"}
                                  loading={actionId === j.id} onClick={() => handleRetry(j.id)}>
                                  {j._count.scenes > 0 ? "Возобновить" : "Перезапустить"}
                                </Button>
                              )}
                              {j._count.scenes > 0 && (
                                <Button variant="outline" size="xs"
                                  title="Пересобрать видео из сохранённых материалов"
                                  loading={actionId === j.id} onClick={() => handleRecompose(j.id)}>
                                  Пересобрать
                                </Button>
                              )}
                              {!["completed", "cancelled", "failed"].includes(j.status) && (
                                <Button variant="danger" size="xs"
                                  loading={actionId === j.id} onClick={() => handleCancel(j.id)}>
                                  Отмена
                                </Button>
                              )}
                            </div>
                          </td>
                        </motion.tr>
                      ))
                  }
                </AnimatePresence>
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs text-text-tertiary">Страница {page} из {totalPages}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Назад</Button>
                <Button variant="outline" size="xs" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Вперёд</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Job detail drawer */}
      <Dialog.Root open={!!detailJob || detailLoading} onOpenChange={(o) => !o && setDetailJob(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed right-0 top-0 bottom-0 w-full max-w-2xl z-50 flex flex-col
            border-l border-border bg-surface-0 shadow-elevation-3 overflow-hidden">

            <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface-1">
              <Dialog.Title className="text-sm font-semibold text-text-primary">
                Детали задачи
              </Dialog.Title>
              <div className="flex items-center gap-2">
                {detailJob && (detailJob.status === "failed" || detailJob.status === "cancelled") && (
                  <Button variant="ghost" size="xs"
                    title={detailJob.scenes.length > 0 ? "Возобновить с точки сбоя" : "Полный перезапуск"}
                    loading={actionId === detailJob.id}
                    onClick={() => handleRetry(detailJob.id)}>
                    {detailJob.scenes.length > 0 ? "Возобновить" : "Перезапустить"}
                  </Button>
                )}
                {detailJob && detailJob.scenes.length > 0 && (
                  <Button variant="outline" size="xs"
                    title="Пересобрать видео из сохранённых материалов"
                    loading={actionId === detailJob.id}
                    onClick={() => handleRecompose(detailJob.id)}>
                    Пересобрать
                  </Button>
                )}
              {detailJob && (
                <>
                  {/* Header info */}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <InfoRow label="ID"      value={detailJob.id} mono />
                    <InfoRow label="Тенант"  value={detailJob.tenant.name} />
                    <InfoRow label="Видео"   value={detailJob.video?.title ?? "—"} />
                    <InfoRow label="Статус"  value={<StatusBadge status={detailJob.status} />} />
                    <InfoRow label="Кредиты" value={String(detailJob.creditsUsed)} />
                    <InfoRow label="Создана" value={relativeTime(detailJob.createdAt)} />
                  </div>

                  {detailJob.error && (
                    <div className="rounded-lg bg-danger/10 border border-danger/20 p-3 text-xs text-danger font-mono">
                      {detailJob.error}
                    </div>
                  )}

                  {/* Scenes */}
                  <div>
                    <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
                      Сцены ({detailJob.scenes.length})
                    </p>
                    <div className="space-y-2">
                      {detailJob.scenes.map(s => (
                        <div key={s.id}
                          className="rounded-lg border border-border bg-surface-1 px-4 py-3 flex items-start gap-4">
                          <span className="text-xs font-mono text-text-tertiary w-4 shrink-0">
                            {s.sceneIndex + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={cn("text-xs font-medium", SCENE_TYPE_COLOR[s.type] ?? "text-text-secondary")}>
                                {s.type}
                              </span>
                              <StatusBadge status={s.status} />
                              <span className="text-xs tabular-nums text-text-tertiary ml-auto">
                                ${Number(s.costUsd).toFixed(4)}
                              </span>
                            </div>
                            {s.error && (
                              <p className="text-[10px] text-danger font-mono mt-1 truncate">{s.error}</p>
                            )}
                            {/* Asset availability indicators */}
                            <div className="flex gap-2 mt-1 flex-wrap">
                              {s.type === 'avatar' && (
                                <AssetBadge label="avatar" ready={!!s.avatarUrl} />
                              )}
                              {s.type === 'clip' && (
                                <>
                                  <AssetBadge label="frame" ready={!!s.frameUrl} />
                                  <AssetBadge label="clip" ready={!!s.clipUrl} />
                                </>
                              )}
                              {s.type === 'image' && (
                                <AssetBadge label="image" ready={!!s.imageUrl} />
                              )}
                            </div>
                            {/* Generation detail */}
                            {s.generations.length > 0 && (
                              <div className="mt-2 space-y-1">
                                {s.generations.map(g => (
                                  <div key={g.id}
                                    className="flex items-center gap-2 text-[10px] text-text-tertiary">
                                    <span className="font-medium text-text-secondary">{g.provider}</span>
                                    <span>{g.model}</span>
                                    <span className="ml-auto tabular-nums">{g.latencyMs ? `${(g.latencyMs / 1000).toFixed(1)}s` : "—"}</span>
                                    <StatusBadge status={g.status} />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Event timeline */}
                  <div>
                    <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
                      Лог событий ({detailJob.events.length})
                    </p>
                    <div className="relative pl-4 space-y-3">
                      <div className="absolute left-1.5 top-2 bottom-2 w-px bg-border" />
                      {detailJob.events.map((ev, i) => (
                        <div key={ev.id} className="relative flex items-start gap-3">
                          <span className={cn(
                            "absolute -left-[11px] top-1 w-2.5 h-2.5 rounded-full border-2 border-surface-0",
                            ev.status === "completed" ? "bg-success"
                            : ev.status === "failed"  ? "bg-danger"
                            : ev.status === "started" ? "bg-brand-500"
                            : "bg-surface-3"
                          )} />
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-text-primary">{ev.stage}</span>
                              <Badge variant={ev.status === "completed" ? "success" : ev.status === "failed" ? "danger" : "default"}>
                                {ev.status}
                              </Badge>
                              <span className="ml-auto text-[10px] text-text-tertiary">
                                {relativeTime(ev.createdAt)}
                              </span>
                            </div>
                            {ev.message && (
                              <p className="text-[10px] text-text-tertiary mt-0.5">{ev.message}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {detailJob && (
              <div className="px-6 py-4 border-t border-border bg-surface-1 flex gap-2 flex-wrap">
                {(detailJob.status === "failed" || detailJob.status === "cancelled") && (
                  <Button variant="primary" size="sm" onClick={() => { handleRetry(detailJob.id); setDetailJob(null); }}>
                    {detailJob.scenes.length > 0 ? "Возобновить" : "Перезапустить"}
                  </Button>
                )}
                {detailJob.scenes.length > 0 && (
                  <Button variant="outline" size="sm"
                    title="Пересобрать видео из уже сохранённых материалов (без регенерации сцен)"
                    loading={actionId === detailJob.id}
                    onClick={() => { handleRecompose(detailJob.id); setDetailJob(null); }}>
                    Пересобрать видео
                  </Button>
                )}
                {!["completed", "cancelled", "failed"].includes(detailJob.status) && (
                  <Button variant="danger" size="sm" onClick={() => { handleCancel(detailJob.id); setDetailJob(null); }}>
                    Отменить задачу
                  </Button>
                )}
                <Dialog.Close asChild>
                  <Button variant="ghost" size="sm" className="ml-auto">Закрыть</Button>
                </Dialog.Close>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-text-tertiary mb-0.5">{label}</p>
      <p className={cn("text-text-primary", mono && "font-mono text-[10px]")}>{value}</p>
    </div>
  );
}

function AssetBadge({ label, ready }: { label: string; ready: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full border",
      ready
        ? "text-success border-success/30 bg-success/10"
        : "text-text-tertiary border-border bg-surface-1"
    )}>
      <span>{ready ? "✓" : "○"}</span>
      <span>{label}</span>
    </span>
  );
}

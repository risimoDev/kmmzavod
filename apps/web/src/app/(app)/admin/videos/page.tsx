"use client";

import { useEffect, useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { Button, Badge, Input, Card, CardContent } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { adminApi, type AdminVideo, type Pagination } from "@/lib/admin-api";
import { relativeTime } from "@/lib/utils";

const STATUS_OPTIONS = ["", "pending", "processing", "composing", "completed", "failed", "cancelled"];

export default function AdminVideosPage() {
  const [videos, setVideos]         = useState<AdminVideo[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0 });
  const [loading, setLoading]       = useState(true);
  const [status, setStatus]         = useState("");
  const [page, setPage]             = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<AdminVideo | null>(null);
  const [deleting, setDeleting]     = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    adminApi.getVideos({ page, status: status || undefined })
      .then(res => { setVideos(res.data); setPagination(res.pagination); })
      .finally(() => setLoading(false));
  }, [page, status]);

  useEffect(() => { load(); }, [load]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await adminApi.deleteVideo(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } finally {
      setDeleting(false);
    }
  };

  const totalPages = Math.ceil(pagination.total / pagination.limit);

  return (
    <div className="p-6 space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1.5 flex-wrap">
          {STATUS_OPTIONS.map(s => (
            <button
              key={s || "all"}
              onClick={() => { setStatus(s); setPage(1); }}
              className={`h-7 px-3 rounded-md text-xs font-medium transition-colors ${
                status === s
                  ? "bg-brand-500/15 text-brand-400 border border-brand-500/30"
                  : "bg-surface-1 text-text-tertiary border border-border hover:text-text-secondary hover:bg-surface-2"
              }`}
            >
              {s || "Все"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-text-tertiary">
          {pagination.total.toLocaleString()} видео
        </span>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-1">
                  {["Название", "Тенант", "Создатель", "Длина", "Кредиты", "Статус", "Создано", ""].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs text-text-tertiary font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {loading && videos.length === 0
                    ? Array.from({ length: 8 }).map((_, i) => (
                        <tr key={i} className="border-b border-border/30">
                          {Array.from({ length: 8 }).map((_, j) => (
                            <td key={j} className="px-4 py-3">
                              <div className="h-3 rounded bg-surface-2 animate-pulse w-20" />
                            </td>
                          ))}
                        </tr>
                      ))
                    : videos.map(v => (
                        <motion.tr key={v.id} layout
                          className="border-b border-border/30 last:border-0 hover:bg-surface-1 transition-colors">
                          <td className="px-4 py-3 max-w-[200px]">
                            <div className="font-medium text-text-primary truncate text-sm">{v.title}</div>
                            <div className="text-[10px] text-text-tertiary font-mono mt-0.5 truncate">{v.id}</div>
                          </td>
                          <td className="px-4 py-3 text-xs text-text-secondary">{v.tenant.name}</td>
                          <td className="px-4 py-3 text-xs text-text-tertiary font-mono">
                            {v.creator?.email ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-xs tabular-nums text-text-secondary">
                            {v.durationSec ? `${Number(v.durationSec).toFixed(0)}s` : "—"}
                          </td>
                          <td className="px-4 py-3 text-xs tabular-nums text-text-secondary">{v.creditsUsed}</td>
                          <td className="px-4 py-3"><StatusBadge status={v.status} /></td>
                          <td className="px-4 py-3 text-xs text-text-tertiary whitespace-nowrap">
                            {relativeTime(v.createdAt)}
                          </td>
                          <td className="px-4 py-3">
                            <Button variant="danger" size="xs"
                              onClick={() => setDeleteTarget(v)}>
                              Удалить
                            </Button>
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

      {/* Delete confirmation */}
      <Dialog.Root open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm z-50">
            <div className="rounded-2xl border border-border bg-surface-1 shadow-elevation-3 p-6">
              <Dialog.Title className="text-sm font-semibold text-text-primary mb-2">
                Удалить видео?
              </Dialog.Title>
              <p className="text-xs text-text-secondary mb-1">
                <strong className="text-text-primary">{deleteTarget?.title}</strong>
              </p>
              <p className="text-xs text-text-tertiary mb-5">
                Будут удалены все сцены, задача обработки и записи о генерации. Это действие необратимо.
              </p>
              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button variant="ghost" size="sm">Отмена</Button>
                </Dialog.Close>
                <Button variant="danger" size="sm" loading={deleting} onClick={confirmDelete}>
                  Удалить навсегда
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

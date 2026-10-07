"use client";

/**
 * Автопилот — новая «фабрика». Настроил на проект один раз → каждый день,
 * несколько раз в день: AI-сценарий + озвучка → умный монтаж → уникализация →
 * публикация через ферму телефонов. См. docs/AUTOPILOT_PLAN.md.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import { Button, Card, CardContent, Badge, LoadingSpinner, EmptyState } from "@/components/ui/primitives";
import { AutopilotForm } from "@/components/autopilot/AutopilotForm";
import { AutopilotStatusBadge, formatWindow } from "@/components/autopilot/status";
import { cn } from "@/lib/utils";
import { autopilotApi, getAccessToken, type Autopilot } from "@/lib/api";

export default function AutopilotListPage() {
  const router = useRouter();
  const [items, setItems] = useState<Autopilot[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => { if (!getAccessToken()) router.replace("/login"); }, [router]);

  const load = useCallback(async () => {
    try {
      const list = await autopilotApi.list();
      setItems(list);
      if (list.length === 0) setShowCreate(true);
    } catch {
      setShowCreate(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="flex flex-col h-full">
      <TopBar
        title="Автопилот"
        subtitle="Монтаж → уникализация → ферма телефонов, каждый день без вашего участия"
        actions={
          <Button variant={showCreate ? "secondary" : "primary"} size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Скрыть" : "+ Новый автопилот"}
          </Button>
        }
      />
      <div className="flex-1 overflow-auto p-4 sm:p-6 space-y-5 animate-slide-up">
        {showCreate && (
          <AutopilotForm
            submitLabel="Создать автопилот"
            onCancel={items.length ? () => setShowCreate(false) : undefined}
            onSubmit={async (v) => {
              const { autopilot } = await autopilotApi.create(v);
              router.push(`/autopilot/${autopilot.id}`);
            }}
          />
        )}

        {loading ? (
          <div className="flex justify-center py-12"><LoadingSpinner size={28} /></div>
        ) : items.length === 0 ? (
          !showCreate && <EmptyState title="Нет автопилотов" description="Создайте первый — и он начнёт выпускать ролики сам." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((a) => (
              <Card key={a.id} hoverable className="cursor-pointer hover:border-brand-500/40 transition-all"
                onClick={() => router.push(`/autopilot/${a.id}`)}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="truncate font-medium text-text-primary">{a.name}</h4>
                      <p className="truncate text-xs text-text-tertiary">{a.project?.name}</p>
                    </div>
                    <AutopilotStatusBadge status={a.status} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{a.montageMode === "single" ? "из 1 видео" : `из ${a.sourcesPerMontage} видео`}</Badge>
                    <Badge variant="outline">{a.publishTimes.length}× в день</Badge>
                    <Badge variant="brand">{a.publishTimes.join(" · ")}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Mini value={a.readyVariants ?? 0} label="копий готово" />
                    <Mini value={a.inFlight ?? 0} label="в монтаже" />
                    <Mini value={a.postsScheduled} label="постов всего" />
                  </div>
                  <div className={cn("text-xs", a.lastError ? "text-warning" : "text-text-tertiary")}>
                    {a.lastError
                      ? a.lastError
                      : a.status === "active" && a.nextWindowAt
                        ? `Следующее окно: ${formatWindow(a.nextWindowAt, a.timezone)}`
                        : a.status === "draft" ? "Не запущен" : ""}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Mini({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg bg-surface-2 py-1.5">
      <div className="text-base font-semibold tabular-nums text-text-primary">{value}</div>
      <div className="text-2xs text-text-tertiary">{label}</div>
    </div>
  );
}

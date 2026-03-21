"use client";

import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { motion } from "framer-motion";
import { Button, Badge, Card, CardContent } from "@/components/ui/primitives";
import { StatCard } from "@/components/ui/composite";
import { adminApi, type PlatformStats, type QueueStat } from "@/lib/admin-api";
import { cn } from "@/lib/utils";

// в”Ђв”Ђ Queue health colour в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

function queueHealth(q: QueueStat): "healthy" | "warn" | "critical" {
  if (q.failed > 10 || q.active + q.waiting > 100) return "critical";
  if (q.failed > 0  || q.active + q.waiting > 20)  return "warn";
  return "healthy";
}

const HEALTH_COLOR = {
  healthy:  "text-success",
  warn:     "text-warning",
  critical: "text-danger",
};

const BAR_COLORS = {
  active:  "#6366f1",
  waiting: "#94a3b8",
  failed:  "#ef4444",
};

// в”Ђв”Ђ Dashboard в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export default function AdminDashboardPage() {
  const [stats, setStats]     = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [refreshAt, setRefreshAt] = useState(0);

  useEffect(() => {
    setLoading(true);
    adminApi.getStats()
      .then(setStats)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [refreshAt]);

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center h-64 text-text-tertiary text-sm">
        Загрузка статистики…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          Ошибка загрузки: {error}
          <Button variant="ghost" size="xs" className="ml-3" onClick={() => setRefreshAt(Date.now())}>
            Повторить
          </Button>
        </div>
      </div>
    );
  }

  // Fallback static data while loading
  const s = stats!;

  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Обзор платформы</h1>
          <p className="text-xs text-text-tertiary mt-0.5">Данные в реальном времени · сегодня</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRefreshAt(Date.now())}>
          Обновить
        </Button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        <StatCard label="Тенантов"          value={String(s.tenants.total)}
                  delta={`${s.tenants.active} акт.`} deltaPositive />
        <StatCard label="Пользователей"      value={String(s.users.total)} />
        <StatCard label="Видео всего"        value={String(s.videos.total)} />
        <StatCard label="Готово сегодня"     value={String(s.videos.completedToday)} deltaPositive
                  delta={s.videos.failedToday > 0 ? `${s.videos.failedToday} ошибок` : undefined} />
        <StatCard label="Задачи активны"     value={String(s.jobs.running)}
                  delta={`${s.jobs.failedAll} ошибок всего`} />
        <StatCard label="Затраты сегодня"    value={`$${s.costUsdToday.toFixed(2)}`} />
      </div>

      {/* Active jobs + credit balance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4 space-y-1">
            <p className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3">
              Кредиты на платформе
            </p>
            <p className="text-3xl font-bold text-text-primary tabular-nums">
              {(s.credits.totalBalance).toLocaleString()}
            </p>
            <p className="text-xs text-text-tertiary">суммарный баланс всех тенантов</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3">
              Очереди — активные / ожидают
            </p>
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={s.queues} barGap={2} barSize={10}>
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: "hsl(var(--text-tertiary))" }}
                    tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--text-tertiary))" }}
                    tickLine={false} axisLine={false} width={22} />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--surface-2))", border: "1px solid hsl(var(--border))",
                      borderRadius: 8, fontSize: 11 }}
                    itemStyle={{ color: "hsl(var(--text-secondary))" }}
                  />
                  <Bar dataKey="active"  name="Активных" fill={BAR_COLORS.active}  radius={[2,2,0,0]} />
                  <Bar dataKey="waiting" name="Ожидают"  fill={BAR_COLORS.waiting} radius={[2,2,0,0]} />
                  <Bar dataKey="failed"  name="Ошибок"   fill={BAR_COLORS.failed}  radius={[2,2,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Queue detail table */}
      <Card>
        <CardContent className="p-0">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <p className="text-sm font-medium text-text-primary">Состояние всех очередей</p>
            <Badge variant={s.queues.some(q => q.failed > 0) ? "danger" : "success"} dot>
              {s.queues.some(q => q.failed > 0) ? "Есть ошибки" : "Норма"}
            </Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-surface-1">
                  {["Очередь", "Активных", "Ожидают", "Задержаны", "Ошибок", "Завершено", "Статус"].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs text-text-tertiary font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.queues.map((q) => {
                  const health = queueHealth(q);
                  return (
                    <motion.tr key={q.name} layout
                      className="border-b border-border/30 last:border-0 hover:bg-surface-1 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-xs text-text-primary">{q.name}</td>
                      <td className={cn("px-4 py-2.5 tabular-nums font-medium", q.active  > 0 ? "text-brand-400"  : "text-text-tertiary")}>{q.active}</td>
                      <td className={cn("px-4 py-2.5 tabular-nums",             q.waiting > 0 ? "text-text-primary" : "text-text-tertiary")}>{q.waiting}</td>
                      <td className={cn("px-4 py-2.5 tabular-nums",             q.delayed > 0 ? "text-warning"    : "text-text-tertiary")}>{q.delayed}</td>
                      <td className={cn("px-4 py-2.5 tabular-nums font-medium", q.failed  > 0 ? "text-danger"     : "text-text-tertiary")}>{q.failed}</td>
                      <td className="px-4 py-2.5 tabular-nums text-text-tertiary">{q.completed.toLocaleString()}</td>
                      <td className={cn("px-4 py-2.5 text-xs font-medium", HEALTH_COLOR[health])}>
                        {health === "healthy" ? "вњ“ Норма" : health === "warn" ? "⚠ Внимание" : "✗ Критично"}
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


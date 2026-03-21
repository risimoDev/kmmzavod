"use client";

import { useEffect, useState, useCallback } from "react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts";
import { Button, Card, CardContent } from "@/components/ui/primitives";
import { adminApi, type UsageRecord, type GenerationRecord, type ProviderCostBreakdown } from "@/lib/admin-api";
import { cn } from "@/lib/utils";

type Range = "7d" | "30d" | "90d";

const PROVIDER_COLORS: Record<string, string> = {
  openai:   "#10b981",
  heygen:   "#8b5cf6",
  kling:    "#f59e0b",
  fal:      "#3b82f6",
  replicate:"#ec4899",
  comfyui:  "#06b6d4",
};

export default function AdminUsagePage() {
  const [range, setRange]               = useState<Range>("30d");
  const [usageData, setUsageData]       = useState<UsageRecord[]>([]);
  const [providers, setProviders]       = useState<ProviderCostBreakdown[]>([]);
  const [generations, setGenerations]   = useState<GenerationRecord[]>([]);
  const [loading, setLoading]           = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    const dateFrom = new Date(Date.now() - days * 86400_000).toISOString();

    Promise.all([
      adminApi.getUsage({ from: dateFrom }),
      adminApi.getGenerations({ from: dateFrom }),
    ]).then(([usageRes, genRes]) => {
      setUsageData(usageRes.data);
      setProviders(genRes.byProvider);
      setGenerations(genRes.data);
    }).finally(() => setLoading(false));
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const totalCost     = providers.reduce((s, p) => s + p.totalCostUsd, 0);
  const totalVideos   = usageData.reduce((s, d) => s + d.videosCreated, 0);
  const totalCredits  = usageData.reduce((s, d) => s + d.creditsUsed, 0);
  const totalApiCalls = generations.length;

  const chartData = usageData.map(d => ({
    date:    d.date.slice(5),           // MM-DD
    videos:  d.videosCreated,
    costUsd: Number(Number(d.totalCostUsd).toFixed(2)),
    credits: d.creditsUsed,
  }));

  const maxCost = Math.max(...providers.map(p => p.totalCostUsd), 1);

  return (
    <div className="p-6 space-y-6">
      {/* Range selector */}
      <div className="flex items-center gap-2">
        {(["7d", "30d", "90d"] as Range[]).map(r => (
          <button key={r} onClick={() => setRange(r)}
            className={cn(
              "h-7 px-3 rounded-md text-xs font-medium border transition-colors",
              range === r
                ? "bg-brand-500/15 text-brand-400 border-brand-500/30"
                : "bg-surface-1 text-text-tertiary border-border hover:text-text-secondary hover:bg-surface-2"
            )}>
            {r}
          </button>
        ))}
        <Button variant="ghost" size="xs" onClick={load} className="ml-auto">
          Обновить
        </Button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Видео создано",    value: totalVideos.toLocaleString(),           sub: "за период" },
          { label: "Стоимость API",    value: `$${totalCost.toFixed(2)}`,             sub: "USD суммарно" },
          { label: "Кредиты списаны",  value: totalCredits.toLocaleString(),          sub: "за период" },
          { label: "API вызовов",      value: totalApiCalls.toLocaleString(),         sub: "генераций AI" },
        ].map(kpi => (
          <Card key={kpi.label}>
            <CardContent className="p-4">
              <p className="text-xs text-text-tertiary mb-1">{kpi.label}</p>
              <p className="text-2xl font-bold text-text-primary tabular-nums">{kpi.value}</p>
              <p className="text-[11px] text-text-tertiary mt-1">{kpi.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Area chart — videos + cost */}
      <Card>
        <CardContent className="p-5">
          <p className="text-sm font-semibold text-text-primary mb-4">Активность по дням</p>
          {loading ? (
            <div className="h-48 bg-surface-1 rounded animate-pulse" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="gVideos" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#8b5cf6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#10b981" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                <YAxis yAxisId="left"  tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "#9ca3af" }} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                <Area yAxisId="left"  type="monotone" dataKey="videos"  fill="url(#gVideos)" stroke="#8b5cf6" strokeWidth={2} name="Видео" />
                <Area yAxisId="right" type="monotone" dataKey="costUsd" fill="url(#gCost)"   stroke="#10b981" strokeWidth={2} name="Cost $" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Provider breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Bar chart */}
        <Card>
          <CardContent className="p-5">
            <p className="text-sm font-semibold text-text-primary mb-4">Затраты по провайдерам</p>
            {loading ? (
              <div className="h-40 bg-surface-1 rounded animate-pulse" />
            ) : (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={providers} layout="vertical" barSize={14}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="provider" width={72} tick={{ fontSize: 11, fill: "#9ca3af" }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: number) => [`$${v.toFixed(3)}`, "Стоимость"]} />
                  <Bar dataKey="totalCostUsd" name="$USD"
                    fill="#8b5cf6"
                    radius={[0, 4, 4, 0]}
                    label={{ position: "right", formatter: (v: number) => `$${v.toFixed(2)}`, fontSize: 10, fill: "#6b7280" }}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Provider table */}
        <Card>
          <CardContent className="p-0">
            <div className="px-5 py-4 border-b border-border">
              <p className="text-sm font-semibold text-text-primary">Детали провайдеров</p>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-1">
                  <th className="px-4 py-2 text-left text-text-tertiary font-medium">Провайдер</th>
                  <th className="px-4 py-2 text-right text-text-tertiary font-medium">Вызовов</th>
                  <th className="px-4 py-2 text-right text-text-tertiary font-medium">Сумма $</th>
                  <th className="px-4 py-2 text-right text-text-tertiary font-medium">Доля</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i} className="border-t border-border/30">
                        <td colSpan={4} className="px-4 py-2.5">
                          <div className="h-3 w-full rounded bg-surface-2 animate-pulse" />
                        </td>
                      </tr>
                    ))
                  : providers.map(p => (
                      <tr key={p.provider} className="border-t border-border/30 hover:bg-surface-1 transition-colors">
                        <td className="px-4 py-2.5 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ background: PROVIDER_COLORS[p.provider] ?? "#6b7280" }} />
                          <span className="text-text-primary font-medium">{p.provider}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">{p.count.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-text-primary">${p.totalCostUsd.toFixed(3)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-text-tertiary">
                          {totalCost > 0 ? `${((p.totalCostUsd / totalCost) * 100).toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    ))
                }
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

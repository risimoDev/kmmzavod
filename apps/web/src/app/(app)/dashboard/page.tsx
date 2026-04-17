"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import { Button, Progress, Badge, LoadingSpinner } from "@/components/ui/primitives";
import { StatCard, VideoCard } from "@/components/ui/composite";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getAccessToken } from "@/lib/api";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

interface DashboardData {
  stats: {
    videosTotal: number;
    videosThisWeek: number;
    activeJobs: number;
    creditsUsed: number;
    creditsTotal: number;
    plan: string;
  };
  chart: Array<{ day: string; videos: number }>;
  recentVideos: Array<{
    id: string;
    title: string;
    status: string;
    thumbnailUrl: string | null;
    durationSec: number | null;
    createdAt: string;
  }>;
  activeJobs: Array<{
    id: string;
    title: string;
    status: string;
    stage: string;
    progress: number;
  }>;
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace("/login");
      return;
    }

    const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
    fetch(`${BASE}/api/v1/videos/dashboard/stats`, {
      headers: {
        Authorization: `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
      },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load data");
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [router]);

  if (loading) {
    return (
      <>
        <TopBar title="Dashboard" />
        <main className="flex-1 flex items-center justify-center">
          <LoadingSpinner size={32} />
        </main>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <TopBar title="Dashboard" />
        <main className="flex-1 flex flex-col items-center justify-center gap-4">
          <p className="text-text-secondary text-sm">{error ?? "No data"}</p>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </main>
      </>
    );
  }

  const STATS = [
    { label: "Videos created", value: String(data.stats.videosTotal), delta: `${data.stats.videosThisWeek} this week`, deltaPositive: true, icon: <VideoIcon /> },
    { label: "Active jobs", value: String(data.stats.activeJobs), delta: "in progress", deltaPositive: true, icon: <ActivityIcon /> },
    { label: "Credits", value: String(data.stats.creditsTotal), delta: `Plan ${data.stats.plan}`, deltaPositive: true, icon: <CreditIcon /> },
  ];

  return (
    <>
      <TopBar
        title="Dashboard"
        actions={
          <Link href="/create">
            <Button variant="primary" icon={<PlusIcon />} size="sm">
              Create video
            </Button>
          </Link>
        }
      />

      <main className="flex-1 p-6 space-y-6 animate-slide-up">
        {/* Stats row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {STATS.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </div>

        {/* Chart + Active jobs */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 rounded-xl border border-border bg-surface-1 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-text-primary">Video creation</p>
                <p className="text-xs text-text-tertiary mt-0.5">Videos in the last 7 days</p>
              </div>
              {data.stats.activeJobs > 0 && <Badge variant="success" dot>Active</Badge>}
            </div>
            {data.chart.length > 0 ? (
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={data.chart} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="cvGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#7C3AED" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#7C3AED" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: "hsl(220 9% 44%)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "hsl(220 9% 44%)" }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(226 14% 12%)",
                      border: "1px solid hsl(226 10% 22%)",
                      borderRadius: "8px",
                      fontSize: "12px",
                      color: "hsl(220 14% 96%)",
                    }}
                    cursor={{ stroke: "#7C3AED", strokeWidth: 1, strokeDasharray: "4 4" }}
                  />
                  <Area type="monotone" dataKey="videos" stroke="#7C3AED" strokeWidth={2} fill="url(#cvGrad)" dot={false} activeDot={{ r: 4, fill: "#7C3AED" }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[160px] flex items-center justify-center text-text-tertiary text-sm">
                No data yet. Create your first video!
              </div>
            )}
          </div>

          <div className="lg:col-span-2 rounded-xl border border-border bg-surface-1 p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-semibold text-text-primary">Active jobs</p>
              <span className="text-xs font-medium text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded-md">
                {data.activeJobs.length}
              </span>
            </div>
            {data.activeJobs.length > 0 ? (
              <ul className="space-y-4">
                {data.activeJobs.map((job) => (
                  <li key={job.id}>
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <p className="text-sm font-medium text-text-primary line-clamp-1 flex-1">{job.title}</p>
                      <StatusBadge status={job.status as any} />
                    </div>
                    <Progress value={job.progress} showLabel size="sm" />
                    <p className="mt-1 text-xs text-text-tertiary">{job.stage}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center justify-center h-24 text-text-tertiary text-sm">
                No active jobs
              </div>
            )}
          </div>
        </div>

        {/* Recent videos grid */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-semibold text-text-primary">Recent videos</p>
            <Link href="/videos" className="text-xs text-brand-400 hover:text-brand-300 transition-colors font-medium">
              All videos →
            </Link>
          </div>
          {data.recentVideos.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {data.recentVideos.map((v) => (
                <VideoCard
                  key={v.id}
                  id={v.id}
                  title={v.title}
                  status={v.status}
                  duration={v.durationSec ?? undefined}
                  createdAt={v.createdAt}
                  onClick={() => router.push(`/videos/${v.id}`)}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-surface-1 p-8 text-center">
              <p className="text-text-tertiary text-sm mb-3">You have no videos yet</p>
              <Link href="/create">
                <Button variant="primary" size="sm">Create your first video</Button>
              </Link>
            </div>
          )}
        </div>

        {/* Credit usage */}
        <div className="rounded-xl border border-border bg-surface-1 px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm font-semibold text-text-primary">Credits</p>
              <p className="text-xs text-text-tertiary mt-0.5">Plan {data.stats.plan}</p>
            </div>
          </div>
          <div className="text-2xl font-bold text-text-primary">{data.stats.creditsTotal}</div>
          <p className="text-xs text-text-tertiary mt-1">credits available</p>
        </div>
      </main>
    </>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function PlusIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
}
function VideoIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M10 9l5 3-5 3V9z" /></svg>;
}
function ActivityIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>;
}
function CreditIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>;
}

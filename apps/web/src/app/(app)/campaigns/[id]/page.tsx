"use client";

/**
 * Деталь кампании — командный центр: пульс (буфер vs спрос), управление
 * (activate/pause/complete/run-now), журнал прогонов и live-лог публикаций.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button, LoadingSpinner, Badge, Card, CardContent, Progress, EmptyState,
} from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime, accountUrl, postUrl, cn } from "@/lib/utils";
import {
  campaignsApi, uniquifyApi, getAccessToken,
  type CampaignDetail, type CampaignRun, type DistributeJob, type DistributeItem,
} from "@/lib/api";

const POLL_MS = 5000;

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<CampaignDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!getAccessToken()) router.replace("/login"); }, [router]);

  const load = useCallback(async () => {
    try { setData(await campaignsApi.get(id)); } catch { /* keep last */ }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Poll while active (live pulse + log).
  useEffect(() => {
    if (data?.campaign.status !== "active") return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [data?.campaign.status, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await load(); } catch (e: any) { alert(e.message ?? "Ошибка"); } finally { setBusy(false); }
  };

  if (!data) return <div className="flex justify-center py-20"><LoadingSpinner size={28} /></div>;

  const c = data.campaign;
  const demandPerDay = c.postsPerAccountPerDay; // ×eligible accounts (не знаем точно на фронте)
  const bufferTarget = demandPerDay * c.bufferDays; // ориентир на 1 аккаунт

  return (
    <div className="flex flex-col h-full">
      <TopBar
        title={c.name}
        subtitle={`Кампания · ${c.contentSource} · ${c.postsPerAccountPerDay}/акк·день`}
        actions={<Button variant="ghost" size="sm" onClick={() => router.push("/campaigns")}>← К кампаниям</Button>}
      />
      <div className="flex-1 overflow-auto p-6 space-y-5 animate-slide-up">
        {/* Управление */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <StatusBadge status={c.status} />
            {c.nextRunAt && c.status === "active" && (
              <span className="text-xs text-text-tertiary">следующий прогон {relativeTime(c.nextRunAt)}</span>
            )}
          </div>
          <div className="flex gap-2">
            {c.status === "active" ? (
              <>
                <Button variant="secondary" size="sm" loading={busy} onClick={() => act(() => campaignsApi.runNow(id))}>Прогнать сейчас</Button>
                <Button variant="secondary" size="sm" loading={busy} onClick={() => act(() => campaignsApi.pause(id))}>Пауза</Button>
              </>
            ) : (c.status === "draft" || c.status === "paused") ? (
              <Button variant="primary" size="sm" loading={busy} onClick={() => act(() => campaignsApi.activate(id))}>Запустить</Button>
            ) : null}
            {c.status !== "completed" && c.status !== "archived" && (
              <Button variant="ghost" size="sm" loading={busy} onClick={() => act(() => campaignsApi.complete(id))}>Завершить</Button>
            )}
          </div>
        </div>

        {c.lastError && (
          <Card className="border-warning/40"><CardContent className="p-3 text-xs text-warning">{c.lastError}</CardContent></Card>
        )}

        {/* Пульс */}
        <div className="grid gap-3 sm:grid-cols-4">
          <Metric label="Буфер готов" value={data.bufferReady} hint={`цель ~${bufferTarget}/аккаунт`} />
          <Metric label="Опубликовано" value={c.postsPublished} />
          <Metric label="Ошибок" value={c.postsFailed} danger={c.postsFailed > 0} />
          <Metric label="Спрос/день" value={`${c.postsPerAccountPerDay}×акк`} />
        </div>

        {/* Конфиг */}
        <Card><CardContent className="p-4 flex flex-wrap gap-1.5">
          <Badge variant="outline">cron: {c.cronExpression}</Badge>
          <Badge variant="outline">{c.timezone}</Badge>
          <Badge variant="outline">стаггер {c.staggerMinutes}м</Badge>
          <Badge variant="outline">буфер {c.bufferDays}д</Badge>
          {c.platforms.map((p) => <Badge key={p} variant="brand">{p}</Badge>)}
          {c.dedupPerAccount && <Badge variant="outline">дедуп</Badge>}
          {c.respectWarmup && <Badge variant="outline">warmup обяз.</Badge>}
          {c.hashtags.length > 0 && <Badge variant="outline">#{c.hashtags.length} тегов</Badge>}
        </CardContent></Card>

        {/* Живые публикации */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text-primary">Публикации кампании</h2>
          {data.distributeJobs.length === 0 ? (
            <EmptyState title="Пока нет публикаций"
              description={c.status === "active" ? "Кампания активна — первые раздачи появятся на ближайшем прогоне." : "Запустите кампанию, чтобы она начала публиковать."} />
          ) : (
            data.distributeJobs.map((d) => <DistributeRow key={d.id} dist={d} />)
          )}
        </section>

        {/* Журнал прогонов */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Журнал прогонов</h2>
          {c.runs.length === 0 ? (
            <p className="text-xs text-text-tertiary">Прогонов ещё не было.</p>
          ) : (
            <div className="space-y-1">
              {c.runs.map((r) => <RunRow key={r.id} run={r} />)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value, hint, danger }: { label: string; value: React.ReactNode; hint?: string; danger?: boolean }) {
  return (
    <Card><CardContent className="p-4">
      <p className="text-xs text-text-tertiary">{label}</p>
      <p className={cn("text-2xl font-semibold", danger ? "text-danger" : "text-text-primary")}>{value}</p>
      {hint && <p className="text-2xs text-text-tertiary mt-0.5">{hint}</p>}
    </CardContent></Card>
  );
}

function RunRow({ run }: { run: CampaignRun }) {
  const s = run.summary ?? {};
  const parts: string[] = [];
  if (typeof s.distributed === "number") parts.push(`разложено ${s.distributed}`);
  if (typeof s.accounts === "number") parts.push(`аккаунтов ${s.accounts}`);
  if (s.skipped) parts.push(String(s.skipped));
  return (
    <div className="flex items-center gap-3 text-xs px-2 py-1.5 rounded hover:bg-surface-2">
      <Badge variant="outline">{run.kind}</Badge>
      <span className="flex-1 text-text-secondary">{parts.join(" · ") || "—"}</span>
      {run.error && <span className="text-danger truncate max-w-[200px]">{run.error}</span>}
      <span className="text-text-tertiary">{relativeTime(run.startedAt)}</span>
    </div>
  );
}

// ── Live publish log (переиспользует шаблон из uniquify job page) ─────────────

function DistributeRow({ dist }: { dist: DistributeJob }) {
  const progress = dist.totalItems > 0 ? Math.round((dist.publishedCount / dist.totalItems) * 100) : 0;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DistributeItem[]>([]);
  const [loading, setLoading] = useState(false);

  const loadItems = useCallback(async () => {
    try { const d = await uniquifyApi.getDistribute(dist.id); setItems(d.items ?? []); }
    catch { /* keep */ } finally { setLoading(false); }
  }, [dist.id]);

  const active = ["pending", "distributing"].includes(dist.status);
  useEffect(() => {
    if (!open) return;
    setLoading(items.length === 0);
    loadItems();
    if (!active) return;
    const t = setInterval(loadItems, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, loadItems]);

  return (
    <Card className="p-4">
      <button className="w-full flex items-center justify-between gap-4 text-left" onClick={() => setOpen((v) => !v)}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-text-tertiary text-xs">{open ? "▾" : "▸"}</span>
            <span className="text-sm font-medium text-text-primary truncate">Раздача {dist.id.slice(0, 8)}</span>
            <StatusBadge status={dist.status} />
          </div>
          <p className="text-xs text-text-tertiary pl-4">
            {dist.publishedCount}/{dist.totalItems} опубл.{dist.failedCount ? ` · ${dist.failedCount} ошибок` : ""}
          </p>
          {dist.totalItems > 0 && <div className="pl-4"><Progress value={progress} max={100} size="sm" showLabel /></div>}
        </div>
        <span className="text-xs text-text-tertiary shrink-0">{relativeTime(dist.createdAt)}</span>
      </button>
      {open && (
        <div className="mt-3 border-t border-border pt-3 space-y-1.5">
          {loading ? <div className="flex justify-center py-3"><LoadingSpinner size={16} /></div>
            : items.length === 0 ? <p className="text-xs text-text-tertiary">Нет позиций.</p>
            : items.map((it) => <PublishLogRow key={it.id} item={it} />)}
        </div>
      )}
    </Card>
  );
}

function PublishLogRow({ item }: { item: DistributeItem }) {
  const acc = item.socialAccount;
  const pj = item.publishJob;
  const profile = accountUrl(acc.platform, acc.accountName);
  const post = postUrl(acc.platform, acc.accountName, pj?.externalPostId);
  const status = pj?.status ?? item.status;
  return (
    <div className="flex items-start gap-2 text-xs py-1 px-1.5 rounded hover:bg-surface-2">
      <span className="text-text-tertiary shrink-0 w-8 font-mono">#{item.uniqueVariant.variantIndex + 1}</span>
      <span className="shrink-0 capitalize text-text-tertiary w-16">{acc.platform}</span>
      <span className="min-w-0 flex-1">
        {profile
          ? <a href={profile} target="_blank" rel="noreferrer" className="text-brand-400 hover:underline">{acc.accountName}</a>
          : <span className="text-text-primary">{acc.accountName}</span>}
        {pj?.error && <span className="block text-danger">{pj.error}</span>}
        {item.error && !pj?.error && <span className="block text-warning">{item.error}</span>}
      </span>
      {post && <a href={post} target="_blank" rel="noreferrer" className="shrink-0 text-brand-400 hover:underline">видео ↗</a>}
      {pj?.publishedAt && <span className="shrink-0 text-text-tertiary">{relativeTime(pj.publishedAt)}</span>}
      <StatusBadge status={status} className="shrink-0" />
    </div>
  );
}

"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  LoadingSpinner,
  Badge,
  Card,
  CardContent,
  Input,
  Textarea,
  Progress,
  EmptyState,
} from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime, accountUrl, postUrl, cn } from "@/lib/utils";
import {
  uniquifyApi,
  socialAccountsApi,
  getAccessToken,
  type UniquifyJobDetail,
  type UniqueVariant,
  type DistributeJob,
  type DistributeItem,
  type SocialAccount,
} from "@/lib/api";

export default function JobDetailPage({ params }: { params: { id: string } }) {
  return (
    <Suspense
      fallback={
        <>
          <TopBar title="Uniquify Job" />
          <main className="flex-1 flex items-center justify-center">
            <LoadingSpinner size={32} />
          </main>
        </>
      }
    >
      <JobDetailContent jobId={params.id} />
    </Suspense>
  );
}

function JobDetailContent({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [job, setJob] = useState<UniquifyJobDetail | null>(null);
  const [variants, setVariants] = useState<UniqueVariant[]>([]);
  const [distributes, setDistributes] = useState<DistributeJob[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showDistributeForm, setShowDistributeForm] = useState(false);
  const [distributing, setDistributing] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [staggerMinutes, setStaggerMinutes] = useState(15);
  const [captionTemplate, setCaptionTemplate] = useState("");
  const [hashtags, setHashtags] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [jobData, variantsData, distData, accData] = await Promise.all([
        uniquifyApi.getJob(jobId),
        uniquifyApi.listVariants(jobId, { limit: 100 }),
        uniquifyApi.listDistributes(jobId),
        socialAccountsApi.list(),
      ]);
      setJob(jobData);
      setVariants(variantsData.items);
      setDistributes(distData.items);
      setAccounts(accData);
    } catch (e: any) {
      if (!silent) setError(e.message ?? "Failed to load job");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace("/login");
      return;
    }
    load();
  }, [load, router]);

  // Live updates: silently re-poll while the job (or any distribution) is active.
  const jobActive =
    !!job && ["pending", "analyzing", "generating"].includes(job.status);
  const distActive = distributes.some((d) =>
    ["pending", "distributing"].includes(d.status),
  );
  useEffect(() => {
    if (!jobActive && !distActive) return;
    const id = setInterval(() => load(true), 4000);
    return () => clearInterval(id);
  }, [jobActive, distActive, load]);

  const handleCreateDistribute = async () => {
    if (selectedAccounts.length === 0) return;
    setDistributing(true);
    try {
      await uniquifyApi.createDistribute(jobId, {
        socialAccountIds: selectedAccounts,
        staggerMinutes,
        captionTemplate: captionTemplate || undefined,
        hashtags: hashtags
          .split(/[\s,]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setShowDistributeForm(false);
      setSelectedAccounts([]);
      load();
    } catch (e: any) {
      alert(e.message ?? "Failed to create distribution");
    } finally {
      setDistributing(false);
    }
  };

  const progress =
    job && job.variantCount > 0
      ? Math.round(((job.completedCount + job.failedCount) / job.variantCount) * 100)
      : 0;

  return (
    <>
      <TopBar
        title="Uniquify Job"
        subtitle={job ? `Job ${job.id.slice(0, 8)} · ${job.variantCount} variants` : undefined}
        actions={
          job?.status === "completed" && (
            <Button variant="primary" size="sm" onClick={() => setShowDistributeForm(true)}>
              <DistributeIcon /> Distribute
            </Button>
          )
        }
      />

      <main className="flex-1 p-6 space-y-6 animate-slide-up">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <LoadingSpinner size={32} />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <p className="text-text-secondary text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={() => load()}>
              Retry
            </Button>
          </div>
        ) : !job ? null : (
          <>
            {/* Job progress */}
            <Card>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-text-primary">Progress</p>
                    <p className="text-xs text-text-tertiary">
                      {job.completedCount} done · {job.failedCount} failed ·{" "}
                      {job.variantCount - job.completedCount - job.failedCount} pending
                    </p>
                  </div>
                  <StatusBadge status={job.status} />
                </div>
                <Progress value={progress} max={100} size="md" showLabel />
                {job.error && (
                  <Badge variant="danger">{job.error}</Badge>
                )}
                <div className="flex items-center gap-2 text-xs text-text-tertiary">
                  <span>Created {relativeTime(job.createdAt)}</span>
                  {job.completedAt && (
                    <>
                      <span>·</span>
                      <span>Completed {relativeTime(job.completedAt)}</span>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Variants */}
            <section>
              <h2 className="text-sm font-semibold text-text-primary mb-3">Variants</h2>
              {variants.length === 0 ? (
                <EmptyState title="No variants yet" description="Wait for the job to complete" />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {variants.map((v) => (
                    <VariantCard key={v.id} variant={v} />
                  ))}
                </div>
              )}
            </section>

            {/* Distributions */}
            <section>
              <h2 className="text-sm font-semibold text-text-primary mb-3">Distributions</h2>
              {distributes.length === 0 ? (
                <EmptyState
                  title="No distributions"
                  description="Distribute variants to multiple social accounts"
                  action={
                    job.status === "completed" && (
                      <Button variant="primary" size="sm" onClick={() => setShowDistributeForm(true)}>
                        <DistributeIcon /> Start Distribution
                      </Button>
                    )
                  }
                />
              ) : (
                <div className="space-y-3">
                  {distributes.map((d) => (
                    <DistributeRow key={d.id} dist={d} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* Distribute modal */}
      {showDistributeForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-surface-1 shadow-elevation-3 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">Distribute Variants</h3>
              <button
                onClick={() => setShowDistributeForm(false)}
                className="text-text-tertiary hover:text-text-primary"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-text-primary">Аккаунты для публикации</label>
                  <div className="flex gap-2">
                    <button type="button" className="text-2xs text-brand-400 hover:underline"
                      onClick={() => setSelectedAccounts(accounts.filter((a) => a.readiness?.canPublish !== false).map((a) => a.id))}>
                      Выбрать готовые
                    </button>
                    <button type="button" className="text-2xs text-text-tertiary hover:underline"
                      onClick={() => setSelectedAccounts([])}>Сброс</button>
                  </div>
                </div>
                <div className="space-y-1 max-h-56 overflow-y-auto border border-border rounded-md p-2 bg-surface-0">
                  {accounts.length === 0 ? (
                    <p className="text-xs text-text-tertiary p-2">Нет аккаунтов. Импортируйте их на странице «Account Farm».</p>
                  ) : (
                    accounts.map((acc) => {
                      const r = acc.readiness;
                      const blocked = r?.canPublish === false;
                      return (
                        <label
                          key={acc.id}
                          className={cn(
                            "flex items-start gap-2 p-1.5 rounded",
                            blocked ? "opacity-60 cursor-not-allowed" : "hover:bg-surface-2 cursor-pointer"
                          )}
                        >
                          <input
                            type="checkbox"
                            disabled={blocked}
                            checked={selectedAccounts.includes(acc.id)}
                            onChange={(e) => {
                              if (e.target.checked) setSelectedAccounts((prev) => [...prev, acc.id]);
                              else setSelectedAccounts((prev) => prev.filter((id) => id !== acc.id));
                            }}
                            className="rounded border-border mt-0.5"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="text-xs text-text-primary capitalize">{acc.platform}</span>
                              <span className="text-xs text-text-tertiary truncate">{acc.accountName}</span>
                              {r && (r.canPublish
                                ? <Badge variant="success" className="text-2xs">готов</Badge>
                                : <Badge variant="danger" className="text-2xs">нельзя</Badge>)}
                            </span>
                            {blocked && r && (
                              <span className="block text-2xs text-danger">{r.blockers.join(" · ")}</span>
                            )}
                            {!blocked && r && r.warnings.length > 0 && (
                              <span className="block text-2xs text-warning">{r.warnings.join(" · ")}</span>
                            )}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
                <p className="text-2xs text-text-tertiary mt-1">
                  «нельзя» — аккаунт не опубликует (нет сессии, пауза, бан, низкий health). Причина показана рядом.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Stagger (minutes)"
                  type="number"
                  min={0}
                  max={1440}
                  value={staggerMinutes}
                  onChange={(e) => setStaggerMinutes(Number(e.target.value))}
                />
                <div />
              </div>

              <Textarea
                label="Caption template"
                placeholder="Use {{index}} and {{platform}} placeholders"
                value={captionTemplate}
                onChange={(e) => setCaptionTemplate(e.target.value)}
                rows={2}
              />

              <Input
                label="Hashtags"
                placeholder="#ai #marketing"
                value={hashtags}
                onChange={(e) => setHashtags(e.target.value)}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowDistributeForm(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={distributing}
                disabled={selectedAccounts.length === 0 || accounts.length === 0}
                onClick={handleCreateDistribute}
              >
                Start Distribution
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function VariantCard({ variant }: { variant: UniqueVariant }) {
  return (
    <Card className="overflow-hidden">
      <div className="aspect-video bg-surface-2 flex items-center justify-center relative">
        {variant.thumbnailUrl ? (
          <img
            src={variant.thumbnailUrl}
            alt={`Variant ${variant.variantIndex}`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="text-text-tertiary text-xs">No preview</div>
        )}
        <div className="absolute top-2 left-2">
          <Badge variant="brand">#{variant.variantIndex + 1}</Badge>
        </div>
        <StatusBadge
          status={variant.status}
          className="absolute top-2 right-2"
        />
      </div>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          {variant.durationSec && <span>{Math.round(variant.durationSec)}s</span>}
          {variant.width && variant.height && (
            <span>
              {variant.width}×{variant.height}
            </span>
          )}
          {variant.subtitleStyle && variant.subtitleStyle !== "none" && (
            <Badge variant="outline" className="text-2xs">{variant.subtitleStyle}</Badge>
          )}
        </div>
        {variant.downloadUrl && (
          <a
            href={variant.downloadUrl}
            target="_blank"
            rel="noreferrer"
            className="block w-full"
          >
            <Button variant="outline" size="sm" className="w-full">
              <DownloadIcon /> Download
            </Button>
          </a>
        )}
        {variant.error && (
          <p className="text-xs text-danger">{variant.error}</p>
        )}
      </CardContent>
    </Card>
  );
}

function DistributeRow({ dist }: { dist: DistributeJob }) {
  const progress = dist.totalItems > 0 ? Math.round((dist.publishedCount / dist.totalItems) * 100) : 0;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DistributeItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  const loadItems = useCallback(async () => {
    try {
      const detail = await uniquifyApi.getDistribute(dist.id);
      setItems(detail.items ?? []);
    } catch { /* keep last items */ } finally {
      setLoadingItems(false);
    }
  }, [dist.id]);

  // Live log: poll item statuses while the distribution is active and expanded.
  const active = ["pending", "distributing"].includes(dist.status);
  useEffect(() => {
    if (!open) return;
    setLoadingItems(items.length === 0);
    loadItems();
    if (!active) return;
    const t = setInterval(loadItems, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, loadItems]);

  return (
    <Card className="p-4">
      <button className="w-full flex items-center justify-between gap-4 text-left"
        onClick={() => setOpen((v) => !v)}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-text-tertiary text-xs">{open ? "▾" : "▸"}</span>
            <p className="text-sm font-medium text-text-primary truncate">
              Публикация {dist.id.slice(0, 8)}
            </p>
            <StatusBadge status={dist.status} />
          </div>
          <p className="text-xs text-text-tertiary pl-4">
            {dist.publishedCount}/{dist.totalItems} опубликовано
            {dist.failedCount > 0 ? ` · ${dist.failedCount} ошибок` : ""} · стаггер {dist.staggerMinutes}мин
          </p>
          {dist.totalItems > 0 && <div className="pl-4"><Progress value={progress} max={100} size="sm" showLabel /></div>}
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-text-tertiary">{relativeTime(dist.createdAt)}</p>
          {dist.error && <p className="text-xs text-danger truncate max-w-[180px]">{dist.error}</p>}
        </div>
      </button>

      {open && (
        <div className="mt-3 border-t border-border pt-3 space-y-1.5">
          {loadingItems ? (
            <div className="flex justify-center py-4"><LoadingSpinner size={18} /></div>
          ) : items.length === 0 ? (
            <p className="text-xs text-text-tertiary">Нет позиций.</p>
          ) : (
            items.map((it) => <PublishLogRow key={it.id} item={it} />)
          )}
        </div>
      )}
    </Card>
  );
}

/** One line of the real-time publish log: account link, status, post link, error. */
function PublishLogRow({ item }: { item: DistributeItem }) {
  const acc = item.socialAccount;
  const pj = item.publishJob;
  const profile = accountUrl(acc.platform, acc.accountName);
  const post = postUrl(acc.platform, acc.accountName, pj?.externalPostId);
  const status = pj?.status ?? item.status;

  return (
    <div className="flex items-start gap-2 text-xs py-1 rounded hover:bg-surface-2 px-1.5">
      <span className="text-text-tertiary shrink-0 w-8 font-mono">#{item.uniqueVariant.variantIndex + 1}</span>
      <span className="shrink-0 capitalize text-text-tertiary w-16">{acc.platform}</span>
      <span className="min-w-0 flex-1">
        {profile ? (
          <a href={profile} target="_blank" rel="noreferrer" className="text-brand-400 hover:underline">
            {acc.accountName}
          </a>
        ) : (
          <span className="text-text-primary">{acc.accountName}</span>
        )}
        {pj?.error && <span className="block text-danger">{pj.error}</span>}
        {item.error && !pj?.error && <span className="block text-warning">{item.error}</span>}
      </span>
      {post && (
        <a href={post} target="_blank" rel="noreferrer"
          className="shrink-0 text-brand-400 hover:underline">видео ↗</a>
      )}
      {pj?.publishedAt && (
        <span className="shrink-0 text-text-tertiary">{relativeTime(pj.publishedAt)}</span>
      )}
      <StatusBadge status={status} className="shrink-0" />
    </div>
  );
}

function DistributeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M12 2v14M5 9l7-7 7 7"/>
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
    </svg>
  );
}

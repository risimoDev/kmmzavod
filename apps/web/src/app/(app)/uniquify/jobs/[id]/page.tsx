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
  const [distributeMode, setDistributeMode] = useState<"matrix" | "quick">("matrix");
  const [distributing, setDistributing] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [staggerMinutes, setStaggerMinutes] = useState(15);
  const [captionTemplate, setCaptionTemplate] = useState("");
  const [hashtags, setHashtags] = useState("");

  interface MatrixRow {
    variantId: string;
    variantIndex: number;
    thumbnailUrl: string | null;
    durationSec: number | null;
    socialAccountId: string;
    caption: string;
    hashtags: string;
    enabled: boolean;
  }
  const [matrixRows, setMatrixRows] = useState<MatrixRow[]>([]);

  const openDistributeModal = () => {
    const readyAccs = accounts.filter((a) => a.readiness?.canPublish !== false);
    const pool = readyAccs.length > 0 ? readyAccs : accounts;
    const completed = variants.filter((v) => v.status === "completed");

    setMatrixRows(
      completed.map((v, i) => ({
        variantId: v.id,
        variantIndex: v.variantIndex,
        thumbnailUrl: v.thumbnailUrl,
        durationSec: v.durationSec,
        socialAccountId: pool[i % (pool.length || 1)]?.id || "",
        caption: v.generatedCaption || "",
        hashtags: (v.generatedHashtags || []).join(" "),
        enabled: true,
      }))
    );
    setSelectedAccounts(readyAccs.map((a) => a.id));
    setShowDistributeForm(true);
  };

  const autoCycleAccounts = () => {
    const readyAccs = accounts.filter((a) => a.readiness?.canPublish !== false);
    const pool = readyAccs.length > 0 ? readyAccs : accounts;
    if (pool.length === 0) return;

    setMatrixRows((prev) =>
      prev.map((row, idx) => ({
        ...row,
        socialAccountId: pool[idx % pool.length].id,
      }))
    );
  };

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
    setDistributing(true);
    try {
      if (distributeMode === "matrix") {
        const enabled = matrixRows.filter((r) => r.enabled && r.socialAccountId);
        if (enabled.length === 0) {
          alert("Выберите хотя бы один активный вариант и назначьте аккаунт");
          setDistributing(false);
          return;
        }
        const uniqueAccounts = Array.from(new Set(enabled.map((r) => r.socialAccountId)));
        const assignments = enabled.map((r) => ({
          variantId: r.variantId,
          socialAccountId: r.socialAccountId,
          caption: r.caption.trim() || undefined,
          hashtags: r.hashtags
            .split(/[\s,]+/)
            .map((h) => h.trim().replace(/^#/, ""))
            .filter(Boolean),
        }));

        await uniquifyApi.createDistribute(jobId, {
          socialAccountIds: uniqueAccounts,
          staggerMinutes,
          assignments,
        });
      } else {
        if (selectedAccounts.length === 0) {
          alert("Выберите хотя бы один аккаунт");
          setDistributing(false);
          return;
        }
        await uniquifyApi.createDistribute(jobId, {
          socialAccountIds: selectedAccounts,
          staggerMinutes,
          captionTemplate: captionTemplate || undefined,
          hashtags: hashtags
            .split(/[\s,]+/)
            .map((t) => t.trim())
            .filter(Boolean),
        });
      }

      setShowDistributeForm(false);
      load();
    } catch (e: any) {
      alert(e.message ?? "Не удалось запустить распределение");
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
        title="Задача уникализации"
        subtitle={job ? `ID: ${job.id.slice(0, 8)} · ${job.variantCount} вариантов` : undefined}
        actions={
          job?.status === "completed" && (
            <Button variant="primary" size="sm" onClick={openDistributeModal}>
              <DistributeIcon /> Матрица публикации
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
                    <p className="text-sm font-medium text-text-primary">Прогресс генерации</p>
                    <p className="text-xs text-text-tertiary">
                      {job.completedCount} готово · {job.failedCount} ошибок ·{" "}
                      {job.variantCount - job.completedCount - job.failedCount} в очереди
                    </p>
                  </div>
                  <StatusBadge status={job.status} />
                </div>
                <Progress value={progress} max={100} size="md" showLabel />
                {job.error && (
                  <Badge variant="danger">{job.error}</Badge>
                )}
                <div className="flex items-center gap-2 text-xs text-text-tertiary">
                  <span>Создано {relativeTime(job.createdAt)}</span>
                  {job.completedAt && (
                    <>
                      <span>·</span>
                      <span>Завершено {relativeTime(job.completedAt)}</span>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Variants */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-text-primary">Уникальные варианты ({variants.length})</h2>
                {job.status === "completed" && (
                  <Button variant="outline" size="sm" onClick={openDistributeModal}>
                    <DistributeIcon /> Распределить по сетке аккаунтов
                  </Button>
                )}
              </div>
              {variants.length === 0 ? (
                <EmptyState title="Варианты генерируются" description="Ожидайте завершения рендеринга вариантов" />
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
              <h2 className="text-sm font-semibold text-text-primary mb-3">Запуски публикаций на телефоны</h2>
              {distributes.length === 0 ? (
                <EmptyState
                  title="Нет активных публикаций"
                  description="Распределите готовые варианты по аккаунтам вашей фермы"
                  action={
                    job.status === "completed" && (
                      <Button variant="primary" size="sm" onClick={openDistributeModal}>
                        <DistributeIcon /> Создать распределение
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

      {/* Distribution Matrix Modal */}
      {showDistributeForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl border border-border bg-surface-1 shadow-elevation-3 overflow-hidden">
            {/* Modal Header */}
            <div className="p-5 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-text-primary">Матрица распределения по ферме телефонов</h3>
                <p className="text-xs text-text-tertiary mt-0.5">
                  Привяжите уникальные варианты к аккаунтам, настройте тайминги и отредактируйте описания перед публикацией
                </p>
              </div>
              <button
                onClick={() => setShowDistributeForm(false)}
                className="text-text-tertiary hover:text-text-primary text-sm p-1 rounded hover:bg-surface-2"
              >
                ✕
              </button>
            </div>

            {/* Mode Switcher Tabs */}
            <div className="flex border-b border-border bg-surface-0 px-5 pt-2 gap-4">
              <button
                onClick={() => setDistributeMode("matrix")}
                className={cn(
                  "pb-2.5 text-xs font-medium border-b-2 transition-colors",
                  distributeMode === "matrix"
                    ? "border-brand text-brand font-semibold"
                    : "border-transparent text-text-secondary hover:text-text-primary"
                )}
              >
                Сетка матрицы (Детальная настройка)
              </button>
              <button
                onClick={() => setDistributeMode("quick")}
                className={cn(
                  "pb-2.5 text-xs font-medium border-b-2 transition-colors",
                  distributeMode === "quick"
                    ? "border-brand text-brand font-semibold"
                    : "border-transparent text-text-secondary hover:text-text-primary"
                )}
              >
                Быстрое авто-распределение
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {distributeMode === "matrix" ? (
                <div className="space-y-4">
                  {/* Global Matrix Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-surface-2 ring-1 ring-border">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-text-secondary">Интервал (stagger):</span>
                        <input
                          type="number"
                          min={0}
                          max={1440}
                          value={staggerMinutes}
                          onChange={(e) => setStaggerMinutes(Math.max(0, +e.target.value || 0))}
                          className="w-16 h-8 rounded bg-surface-1 border border-border text-center text-xs text-text-primary"
                        />
                        <span className="text-xs text-text-tertiary">мин</span>
                      </div>
                      <span className="text-border">|</span>
                      <Button variant="outline" size="sm" onClick={autoCycleAccounts}>
                        Распределить по очереди (Round-Robin)
                      </Button>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="text-2xs text-brand hover:underline"
                        onClick={() => setMatrixRows((prev) => prev.map((r) => ({ ...r, enabled: true })))}
                      >
                        Выбрать все
                      </button>
                      <span className="text-text-tertiary text-2xs">·</span>
                      <button
                        type="button"
                        className="text-2xs text-text-tertiary hover:underline"
                        onClick={() => setMatrixRows((prev) => prev.map((r) => ({ ...r, enabled: false })))}
                      >
                        Снять все
                      </button>
                    </div>
                  </div>

                  {/* Matrix Rows Table */}
                  <div className="border border-border rounded-lg overflow-hidden bg-surface-0">
                    <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-surface-2 text-[11px] font-medium text-text-secondary border-b border-border">
                      <div className="col-span-1 flex items-center">Вкл</div>
                      <div className="col-span-3">Ролик</div>
                      <div className="col-span-3">Целевой аккаунт</div>
                      <div className="col-span-2">Расписание</div>
                      <div className="col-span-3">Текст / Хэштеги</div>
                    </div>

                    <div className="divide-y divide-border max-h-96 overflow-y-auto">
                      {matrixRows.map((row, idx) => {
                        const enabledIndex = matrixRows.slice(0, idx).filter((r) => r.enabled).length;
                        const delayMin = enabledIndex * staggerMinutes;

                        return (
                          <div
                            key={row.variantId}
                            className={cn(
                              "grid grid-cols-12 gap-2 px-3 py-2.5 items-center text-xs transition-colors",
                              row.enabled ? "hover:bg-surface-2/60" : "opacity-40 bg-surface-1"
                            )}
                          >
                            {/* Checkbox */}
                            <div className="col-span-1 flex items-center">
                              <input
                                type="checkbox"
                                checked={row.enabled}
                                onChange={(e) =>
                                  setMatrixRows((prev) =>
                                    prev.map((r, i) => (i === idx ? { ...r, enabled: e.target.checked } : r))
                                  )
                                }
                                className="rounded border-border cursor-pointer"
                              />
                            </div>

                            {/* Thumbnail & Index */}
                            <div className="col-span-3 flex items-center gap-2">
                              <div className="w-12 h-16 rounded bg-surface-2 overflow-hidden flex-shrink-0 relative ring-1 ring-border">
                                {row.thumbnailUrl ? (
                                  <img
                                    src={row.thumbnailUrl}
                                    alt={`#${row.variantIndex + 1}`}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-[9px] text-text-tertiary">
                                    N/A
                                  </div>
                                )}
                                <span className="absolute bottom-0.5 right-0.5 bg-black/75 px-1 py-0.2 text-[9px] font-semibold text-white rounded">
                                  #{row.variantIndex + 1}
                                </span>
                              </div>
                              <div className="min-w-0">
                                <p className="font-medium text-text-primary truncate">Вариант #{row.variantIndex + 1}</p>
                                {row.durationSec && (
                                  <p className="text-[11px] text-text-tertiary">{Math.round(row.durationSec)} сек</p>
                                )}
                              </div>
                            </div>

                            {/* Social Account Select */}
                            <div className="col-span-3">
                              <select
                                value={row.socialAccountId}
                                disabled={!row.enabled}
                                onChange={(e) =>
                                  setMatrixRows((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, socialAccountId: e.target.value } : r
                                    )
                                  )
                                }
                                className="w-full h-8 rounded bg-surface-1 ring-1 ring-border px-2 text-xs text-text-primary"
                              >
                                <option value="">— Выберите аккаунт —</option>
                                {accounts.map((acc) => (
                                  <option key={acc.id} value={acc.id}>
                                    {acc.platform.toUpperCase()}: {acc.accountName}
                                    {acc.readiness?.canPublish === false ? " (не готов)" : ""}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {/* Schedule Delay */}
                            <div className="col-span-2">
                              {row.enabled ? (
                                <Badge variant="neutral" className="text-2xs">
                                  {delayMin === 0 ? "Сразу" : `+${delayMin} мин`}
                                </Badge>
                              ) : (
                                <span className="text-2xs text-text-tertiary">Пропущен</span>
                              )}
                            </div>

                            {/* Caption & Hashtags preview / inline edit */}
                            <div className="col-span-3 space-y-1">
                              <textarea
                                value={row.caption}
                                disabled={!row.enabled}
                                rows={2}
                                onChange={(e) =>
                                  setMatrixRows((prev) =>
                                    prev.map((r, i) => (i === idx ? { ...r, caption: e.target.value } : r))
                                  )
                                }
                                placeholder="Заголовок/описание..."
                                className="w-full text-[11px] p-1.5 rounded bg-surface-1 ring-1 ring-border text-text-primary resize-none"
                              />
                              <input
                                type="text"
                                value={row.hashtags}
                                disabled={!row.enabled}
                                onChange={(e) =>
                                  setMatrixRows((prev) =>
                                    prev.map((r, i) => (i === idx ? { ...r, hashtags: e.target.value } : r))
                                  )
                                }
                                placeholder="#хэштеги..."
                                className="w-full h-6 text-[10px] px-1.5 rounded bg-surface-1 ring-1 ring-border text-text-tertiary"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                /* Quick mode */
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-sm font-medium text-text-primary">Аккаунты для публикации</label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="text-2xs text-brand-400 hover:underline"
                          onClick={() => setSelectedAccounts(accounts.filter((a) => a.readiness?.canPublish !== false).map((a) => a.id))}
                        >
                          Выбрать готовые
                        </button>
                        <button
                          type="button"
                          className="text-2xs text-text-tertiary hover:underline"
                          onClick={() => setSelectedAccounts([])}
                        >
                          Сброс
                        </button>
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
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label="Интервал между постами (минуты)"
                      type="number"
                      min={0}
                      max={1440}
                      value={staggerMinutes}
                      onChange={(e) => setStaggerMinutes(Number(e.target.value))}
                    />
                    <div />
                  </div>

                  <Textarea
                    label="Шаблон описания (опционально)"
                    placeholder="Используйте {{index}} и {{platform}}"
                    value={captionTemplate}
                    onChange={(e) => setCaptionTemplate(e.target.value)}
                    rows={2}
                  />

                  <Input
                    label="Общие хэштеги"
                    placeholder="#ai #marketing #trending"
                    value={hashtags}
                    onChange={(e) => setHashtags(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-border bg-surface-0 flex items-center justify-between">
              <div className="text-xs text-text-secondary">
                {distributeMode === "matrix" ? (
                  <span>
                    Выбрано: <strong>{matrixRows.filter((r) => r.enabled && r.socialAccountId).length}</strong> роликов на{" "}
                    <strong>{new Set(matrixRows.filter((r) => r.enabled && r.socialAccountId).map((r) => r.socialAccountId)).size}</strong> аккаунтов
                  </span>
                ) : (
                  <span>
                    Аккаунтов выбрано: <strong>{selectedAccounts.length}</strong>
                  </span>
                )}
              </div>

              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowDistributeForm(false)}>
                  Отмена
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={distributing}
                  onClick={handleCreateDistribute}
                >
                  Запустить публикацию
                </Button>
              </div>
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

"use client";

/**
 * Автопилот — пульт: конвейер (исходники → монтаж → копии → телефоны → посты),
 * монтажи с этапами, публикации, готовность телефонов, журнал и настройки.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import { Button, Card, CardContent, Badge, LoadingSpinner } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { AutopilotForm } from "@/components/autopilot/AutopilotForm";
import { AutopilotStatusBadge, BATCH_STAGES, formatWindow, stageIndex } from "@/components/autopilot/status";
import { cn, relativeTime } from "@/lib/utils";
import { autopilotApi, type AutopilotBatch, type AutopilotDetail, type AutopilotInput, type AutopilotRun } from "@/lib/api";

export default function AutopilotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<AutopilotDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await autopilotApi.get(id));
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? "Не удалось загрузить");
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden && !editing) void load(); }, 8_000);
    return () => clearInterval(t);
  }, [load, editing]);

  async function act(name: string, fn: () => Promise<{ warnings?: string[]; message?: string } | unknown>) {
    setBusy(name);
    setNotice(null);
    try {
      const r = (await fn()) as { warnings?: string[]; message?: string } | undefined;
      if (r?.warnings?.length) setNotice({ tone: "warn", text: r.warnings.join(" · ") });
      else if (r?.message) setNotice({ tone: "ok", text: r.message });
      await load();
    } catch (e: any) {
      setNotice({ tone: "err", text: e?.message ?? "Ошибка" });
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <div className="flex h-full flex-col">
        <TopBar title="Автопилот" />
        <div className="flex flex-1 items-center justify-center">
          {loadError ? <p className="text-sm text-danger">{loadError}</p> : <LoadingSpinner size={28} />}
        </div>
      </div>
    );
  }

  const { autopilot: ap, batches, runs, accounts, sources, readyVariants, posts, aiKeys } = data;
  const okPhones = accounts.filter((a) => a.ok).length;
  const inFlight = batches.filter((b) => !["ready", "failed"].includes(b.status));
  const published = posts.filter((p) => p.status === "published").length;

  return (
    <div className="flex h-full flex-col">
      <TopBar
        title={ap.name}
        subtitle={`Проект «${ap.project.name}» · ${ap.publishTimes.join(", ")} (${ap.timezone})`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <AutopilotStatusBadge status={ap.status} />
            {ap.status === "active" ? (
              <>
                <Button size="sm" variant="outline" loading={busy === "produce"} onClick={() => act("produce", () => autopilotApi.produceNow(id))}>Смонтировать сейчас</Button>
                <Button size="sm" variant="outline" loading={busy === "publish"} disabled={readyVariants === 0} onClick={() => act("publish", () => autopilotApi.publishNow(id))}>Опубликовать сейчас</Button>
                <Button size="sm" variant="secondary" loading={busy === "pause"} onClick={() => act("pause", () => autopilotApi.pause(id))}>Пауза</Button>
              </>
            ) : (
              <Button size="sm" variant="primary" loading={busy === "activate"} onClick={() => act("activate", () => autopilotApi.activate(id))}>
                {ap.status === "draft" ? "Запустить" : "Возобновить"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>{editing ? "Закрыть настройки" : "Настройки"}</Button>
          </div>
        }
      />

      <div className="flex-1 overflow-auto p-4 sm:p-6 space-y-5 animate-slide-up">
        {notice && (
          <p className={cn("rounded-lg px-3 py-2 text-sm",
            notice.tone === "ok" && "bg-success/10 text-success",
            notice.tone === "warn" && "bg-warning/10 text-warning",
            notice.tone === "err" && "bg-danger/10 text-danger")}>{notice.text}</p>
        )}
        {(ap.status === "error" || ap.lastError) && (
          <div className={cn("rounded-xl border px-4 py-3 text-sm",
            ap.status === "error" ? "border-danger/40 bg-danger/10 text-danger" : "border-warning/30 bg-warning/10 text-warning")}>
            <div className="font-medium">{ap.status === "error" ? "Автопилот остановлен после серии ошибок" : "Требует внимания"}</div>
            {ap.lastError && <div className="mt-0.5 text-xs opacity-90">{ap.lastError}</div>}
          </div>
        )}
        {(!aiKeys.fishAudio || !aiKeys.openrouter) && (
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
            {!aiKeys.fishAudio && "Не задан ключ Fish Audio — озвучка не сработает. "}
            {!aiKeys.openrouter && "Не задан ключ OpenRouter — сценарии шаблонные. "}
            Админ → Настройки → «Провайдеры AI».
          </p>
        )}

        {editing ? (
          <AutopilotForm
            initial={toInput(ap)}
            submitLabel="Сохранить настройки"
            onCancel={() => setEditing(false)}
            onSubmit={async (v) => {
              const { warnings } = await autopilotApi.update(id, v);
              setEditing(false);
              setNotice(warnings.length ? { tone: "warn", text: warnings.join(" · ") } : { tone: "ok", text: "Настройки сохранены" });
              await load();
            }}
          />
        ) : (
          <>
            {/* ── Pipeline strip ───────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <Flow label="Исходники" value={sources.total} sub={`${sources.fresh} ещё не использованы`} tone={sources.total ? undefined : "bad"} />
              <Flow label="В производстве" value={inFlight.length} sub={inFlight.length ? stageSummary(inFlight) : "ожидает спроса"} />
              <Flow label="Копий готово" value={readyVariants} sub="в буфере к публикации" tone={readyVariants ? "ok" : undefined} />
              <Flow label="Телефоны" value={`${okPhones}/${accounts.length}`} sub="готовы публиковать" tone={okPhones ? "ok" : "bad"} />
              <Flow label="Следующее окно" value={ap.status === "active" && ap.nextWindowAt ? new Date(ap.nextWindowAt).toLocaleTimeString("ru-RU", { timeZone: ap.timezone, hour: "2-digit", minute: "2-digit" }) : "—"}
                sub={ap.status === "active" && ap.nextWindowAt ? formatWindow(ap.nextWindowAt, ap.timezone) : ap.status === "active" ? "вычисляется…" : "автопилот не запущен"} />
            </div>

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
              <div className="space-y-5 min-w-0">
                {/* ── Batches ────────────────────────────────────────────── */}
                <section className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-semibold text-text-primary">Монтажи</h3>
                    <span className="text-xs text-text-tertiary">всего готово: {ap.montagesProduced} · копий: {ap.variantsProduced}</span>
                  </div>
                  {batches.length === 0 ? (
                    <Card><CardContent className="p-6 text-center text-sm text-text-tertiary">
                      {ap.status === "active" ? "Первый монтаж стартует в течение минуты…" : "Запустите автопилот — монтажи появятся здесь."}
                    </CardContent></Card>
                  ) : (
                    <div className="space-y-2">{batches.map((b) => <BatchRow key={b.id} b={b} />)}</div>
                  )}
                </section>

                {/* ── Posts ──────────────────────────────────────────────── */}
                <section className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-semibold text-text-primary">Публикации</h3>
                    <span className="text-xs text-text-tertiary">поставлено всего: {ap.postsScheduled} · среди последних опубликовано: {published}</span>
                  </div>
                  {posts.length === 0 ? (
                    <Card><CardContent className="p-6 text-center text-sm text-text-tertiary">Посты появятся после первого окна публикации.</CardContent></Card>
                  ) : (
                    <Card>
                      <CardContent className="divide-y divide-border p-0">
                        {posts.map((p) => (
                          <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                            <div className="h-12 w-7 shrink-0 overflow-hidden rounded bg-surface-2">
                              {p.thumbnailUrl && <img src={p.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm text-text-primary">{p.socialAccount.accountName}
                                <span className="ml-1.5 text-2xs text-text-tertiary">{p.socialAccount.platform} · тел. {p.socialAccount.deviceId ?? "—"}</span>
                              </div>
                              <div className="truncate text-2xs text-text-tertiary">
                                копия #{p.uniqueVariant.variantIndex + 1}
                                {p.publishedAt ? ` · опубликовано ${relativeTime(p.publishedAt)}` : p.scheduledAt ? ` · запланировано ${relativeTime(p.scheduledAt)}` : ""}
                              </div>
                              {(p.error || p.publishJob?.error) && <div className="truncate text-2xs text-danger" title={p.error ?? p.publishJob?.error ?? ""}>{p.error ?? p.publishJob?.error}</div>}
                            </div>
                            <StatusBadge status={p.status} />
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}
                </section>
              </div>

              <div className="space-y-5">
                {/* ── Phones ─────────────────────────────────────────────── */}
                <section className="space-y-2">
                  <h3 className="font-semibold text-text-primary">Телефоны</h3>
                  <Card>
                    <CardContent className="max-h-72 space-y-1 overflow-auto p-3">
                      {accounts.length === 0 && <p className="text-xs text-text-tertiary">Нет аккаунтов с методом «телефон» в охвате.</p>}
                      {accounts.map((a) => (
                        <div key={a.id} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate text-text-secondary">{a.accountName} <span className="text-text-tertiary">· {a.platform}</span></span>
                          {a.ok ? <Badge variant="success">готов</Badge> : <span className="truncate text-2xs text-danger" title={a.blockers.join(", ")}>{a.blockers.join(", ")}</span>}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </section>

                {/* ── Journal ────────────────────────────────────────────── */}
                <section className="space-y-2">
                  <h3 className="font-semibold text-text-primary">Журнал</h3>
                  <Card>
                    <CardContent className="max-h-[560px] space-y-2.5 overflow-auto p-3">
                      {runs.length === 0 && <p className="text-xs text-text-tertiary">Пока пусто.</p>}
                      {runs.map((r) => <RunRow key={r.id} r={r} />)}
                    </CardContent>
                  </Card>
                </section>

                <Button size="sm" variant="ghost" className="text-danger"
                  onClick={async () => {
                    if (!confirm(`Удалить автопилот «${ap.name}»? Уже созданные ролики и посты останутся.`)) return;
                    await autopilotApi.remove(id);
                    router.push("/autopilot");
                  }}>Удалить автопилот</Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Flow({ label, value, sub, tone }: { label: string; value: number | string; sub: string; tone?: "ok" | "bad" }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-2xs uppercase tracking-wide text-text-tertiary">{label}</div>
        <div className={cn("text-2xl font-semibold tabular-nums",
          tone === "ok" ? "text-success" : tone === "bad" ? "text-danger" : "text-text-primary")}>{value}</div>
        <div className="truncate text-2xs text-text-tertiary" title={sub}>{sub}</div>
      </CardContent>
    </Card>
  );
}

function stageSummary(batches: AutopilotBatch[]): string {
  const labels: Record<string, string> = {
    pending: "в очереди", scripting: "сценарий", analyzing: "раскадровка", rendering: "рендер", uniquifying: "уникализация",
  };
  const counts = new Map<string, number>();
  for (const b of batches) counts.set(b.status, (counts.get(b.status) ?? 0) + 1);
  return [...counts].map(([s, n]) => `${labels[s] ?? s}${n > 1 ? ` ×${n}` : ""}`).join(", ");
}

function BatchRow({ b }: { b: AutopilotBatch }) {
  const [open, setOpen] = useState(false);
  const idx = stageIndex(b.status);
  const failed = b.status === "failed";
  return (
    <Card className={cn(failed && "border-danger/30")}>
      <CardContent className="p-3">
        <div className="flex gap-3">
          <div className="h-20 w-12 shrink-0 overflow-hidden rounded-md bg-surface-2">
            {b.thumbnailUrl && <img src={b.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="font-medium text-text-primary">Монтаж #{b.id.slice(0, 8)}</span>
              {b.scriptStyle && <Badge variant="outline">{b.scriptStyle}</Badge>}
              {b.voiceDuration != null && <span className="text-text-tertiary">{Number(b.voiceDuration).toFixed(1)}с</span>}
              <span className="text-text-tertiary">· {b.sourceVideoIds.length} исх.</span>
              <span className="ml-auto text-text-tertiary">{relativeTime(b.createdAt)}</span>
            </div>
            {/* Stage stepper */}
            <div className="flex items-center gap-1">
              {BATCH_STAGES.map((s, i) => (
                <div key={s.id} className="flex-1">
                  <div className={cn("h-1.5 rounded-full",
                    failed ? "bg-danger/30" : i < idx || b.status === "ready" ? "bg-success" : i === idx ? "bg-brand-500 animate-pulse" : "bg-surface-3")} />
                  <div className={cn("mt-0.5 truncate text-2xs", i === idx && !failed ? "text-brand-400" : "text-text-tertiary")}>{s.label}</div>
                </div>
              ))}
            </div>
            {b.uniquify && (
              <div className="text-2xs text-text-tertiary">
                Копии: {b.uniquify.completedCount}/{b.uniquify.variantCount}{b.uniquify.failedCount ? ` · ошибок ${b.uniquify.failedCount}` : ""}
              </div>
            )}
            {b.error && <div className="text-xs text-danger">{b.error}</div>}
            <div className="flex flex-wrap gap-3 text-2xs">
              {b.script && <button type="button" className="text-brand-400 hover:underline" onClick={() => setOpen((v) => !v)}>{open ? "скрыть сценарий" : "сценарий"}</button>}
              {b.editProjectId && <Link href={`/editor/${b.editProjectId}`} className="text-text-tertiary hover:text-brand-400">монтаж ↗</Link>}
              {b.uniquifyJobId && <Link href={`/uniquify/jobs/${b.uniquifyJobId}`} className="text-text-tertiary hover:text-brand-400">копии ↗</Link>}
            </div>
            {open && b.script && <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-xs text-text-secondary">{b.script}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const RUN_TONE: Record<AutopilotRun["kind"], string> = {
  produce: "bg-brand-400",
  advance: "bg-info",
  distribute: "bg-success",
  error: "bg-danger",
  info: "bg-text-tertiary",
};

function RunRow({ r }: { r: AutopilotRun }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", RUN_TONE[r.kind])} />
      <div className="min-w-0">
        <div className={cn(r.kind === "error" ? "text-danger" : "text-text-secondary")}>{r.message}</div>
        {r.error && <div className="break-words text-2xs text-danger/80">{r.error}</div>}
        <div className="text-2xs text-text-tertiary">{relativeTime(r.createdAt)}</div>
      </div>
    </div>
  );
}

function toInput(ap: AutopilotDetail["autopilot"]): Partial<AutopilotInput> {
  return {
    name: ap.name,
    projectId: ap.projectId,
    montageMode: ap.montageMode,
    sourcesPerMontage: ap.sourcesPerMontage,
    sourceStrategy: ap.sourceStrategy,
    pace: ap.pace ?? "normal",
    targetSeconds: ap.targetSeconds,
    aspect: ap.aspect,
    subtitleStyle: ap.subtitleStyle,
    smartCrop: ap.smartCrop,
    bgmKeys: ap.bgmKeys,
    productInfo: ap.productInfo ?? "",
    scriptStyles: ap.scriptStyles,
    ctaType: ap.ctaType,
    directWord: ap.directWord ?? "",
    voiceIds: ap.voiceIds,
    voiceSpeed: Number(ap.voiceSpeed),
    uniquifyMode: "preserve_context",
    stealthLevel: ap.stealthLevel,
    variantsPerMontage: ap.variantsPerMontage ?? null,
    accountGroupId: ap.accountGroupId ?? null,
    socialAccountIds: ap.socialAccountIds,
    platforms: ap.platforms,
    publishTimes: ap.publishTimes,
    timezone: ap.timezone,
    jitterMinutes: ap.jitterMinutes,
    staggerMinutes: ap.staggerMinutes,
    minHealth: ap.minHealth,
    captionTemplate: ap.captionTemplate ?? "",
    hashtags: ap.hashtags,
    bufferWindows: ap.bufferWindows,
    maxParallelBatches: ap.maxParallelBatches,
  };
}

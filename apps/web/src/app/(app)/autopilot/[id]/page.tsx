"use client";

/**
 * Автопилот — пульт: конвейер (исходники → монтаж → копии → телефоны → посты),
 * мониторинг в реальном времени, живой прогресс-бар, быстрое ручное управление,
 * перезапуск упавших публикаций, готовность телефонов, журнал и настройки.
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
      const res = await autopilotApi.get(id);
      setData(res);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? "Не удалось загрузить данные автопилота");
    }
  }, [id]);

  // Вычисляем, активен ли сейчас процесс (для динамического живого опроса каждые 2.5 секунды)
  const isPublishingNow = Boolean(
    data?.posts.some((p) => p.status === "publishing") ||
    data?.liveProgress?.isPublishing ||
    data?.batches.some((b) => !["ready", "failed"].includes(b.status)) ||
    busy
  );

  useEffect(() => {
    void load();
    const interval = isPublishingNow ? 2_500 : 7_000;
    const t = setInterval(() => {
      if (!document.hidden && !editing) void load();
    }, interval);
    return () => clearInterval(t);
  }, [load, editing, isPublishingNow]);

  async function act(name: string, fn: () => Promise<{ warnings?: string[]; message?: string } | unknown>) {
    setBusy(name);
    setNotice(null);
    try {
      const r = (await fn()) as { warnings?: string[]; message?: string } | undefined;
      if (r?.warnings?.length) setNotice({ tone: "warn", text: r.warnings.join(" · ") });
      else if (r?.message) setNotice({ tone: "ok", text: r.message });
      await load();
    } catch (e: any) {
      setNotice({ tone: "err", text: e?.message ?? "Ошибка при выполнении действия" });
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

  const { autopilot: ap, batches, runs, accounts, sources, readyVariants, posts, aiKeys, farmProxy, liveProgress } = data;
  const okPhones = accounts.filter((a) => a.ok).length;
  const inFlight = batches.filter((b) => !["ready", "failed"].includes(b.status));

  // Метрики публикаций: истинные агрегаты из базы данных (никогда не зависят от размера выборки)
  const unconfirmedPosts = posts.filter((p) => p.status === "published" && Boolean((p.error ?? p.publishJob?.error)?.includes("появление в профиле ожидается")));
  const basePublished = liveProgress?.publishedCount ?? posts.filter((p) => p.status === "published").length;
  const published = Math.max(0, basePublished - unconfirmedPosts.length);
  const publishingCount = liveProgress?.publishingCount ?? posts.filter((p) => p.status === "publishing").length;
  const scheduledCount = liveProgress?.scheduledCount ?? posts.filter((p) => p.status === "scheduled").length;
  const failedCount = (liveProgress?.failedCount ?? posts.filter((p) => p.status === "failed" || p.status === "skipped").length) + unconfirmedPosts.length;

  const publishingPosts = posts.filter((p) => p.status === "publishing");
  const scheduledPosts = posts.filter((p) => p.status === "scheduled");
  const failedPosts = posts.filter((p) => p.status === "failed" || p.status === "skipped" || Boolean((p.error ?? p.publishJob?.error)?.includes("появление в профиле ожидается")));

  // Полный объём цикла: всё, что запланировано, публикуется, завершено или упало
  const totalCyclePosts = Math.max(liveProgress?.cycleTotal ?? (published + publishingCount + scheduledCount + failedCount), 1);
  const progressPercent = Math.min(100, Math.round((published / totalCyclePosts) * 100));

  const isActivelyPublishing = publishingCount > 0 || publishingPosts.length > 0 || Boolean(liveProgress?.activeItem);
  const isPublishing = isActivelyPublishing;
  const isProducing = inFlight.length > 0;
  const hasFailed = failedCount > 0;
  const hasScheduled = scheduledCount > 0;

  // Динамический статус текущего шага в реальном времени
  let liveStatusTitle = "Автопилот в штатном режиме";
  let liveStatusSubtitle = "Ожидание планового окна публикации";
  let currentActionDetail: string | null = null;

  if (isActivelyPublishing) {
    liveStatusTitle = "Идёт публикация на стойку телефонов";
    const active = publishingPosts[0] || (liveProgress?.activeItem ? posts.find((p) => p.id === liveProgress.activeItem?.id) : null);
    const liveAct = liveProgress?.liveAction;
    const devId = liveAct?.deviceId || active?.socialAccount.deviceId;
    const devShort = devId ? (devId.length > 12 ? devId.slice(0, 10) + "..." : devId) : "USB-плата";
    const accName = liveAct?.accountName || active?.socialAccount.accountName || "телефон";
    const platformName = (liveAct?.platform || active?.socialAccount.platform) === "tiktok" ? "TikTok" : "Instagram";

    liveStatusSubtitle = `Аккаунт: ${accName} (${platformName})`;

    if (liveProgress?.currentAction) {
      currentActionDetail = `[${devShort}] ${liveProgress.currentAction}${liveAct?.percent != null ? ` (${liveAct.percent}%)` : ""}`;
    } else if (active) {
      currentActionDetail = `[${devShort}] передача ролика в ${platformName} (с ротацией IP и ИИ-контролем)...`;
    } else {
      liveStatusSubtitle = "В процессе: обработка задачи на стойке...";
      currentActionDetail = "Плата загружает видео и проверяет сетевое окружение...";
    }
  } else if (isProducing) {
    const activeBatch = inFlight[0];
    liveStatusTitle = "Идёт производство контента";
    liveStatusSubtitle = `Монтаж #${activeBatch.id.slice(0, 8)} (${stageSummary([activeBatch])})`;
    currentActionDetail = activeBatch.uniquify
      ? `Уникализация видеокопий: создано ${activeBatch.uniquify.completedCount} из ${activeBatch.uniquify.variantCount}`
      : `Текущий этап: ${BATCH_STAGES[stageIndex(activeBatch.status)]?.label || activeBatch.status}`;
  } else if (hasScheduled) {
    const nextItem = [...scheduledPosts].sort((a, b) => {
      const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0;
      const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0;
      return ta - tb;
    })[0];
    const nextTimeStr = nextItem?.scheduledAt ? new Date(nextItem.scheduledAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "скоро";
    liveStatusTitle = `В очереди к публикации: ${scheduledCount} постов`;
    liveStatusSubtitle = `Следующий запуск: ~${nextTimeStr} (поочерёдная публикация плат)`;
    currentActionDetail = "Посты распределяются последовательно с защитой стойки от блокировок. Нажмите «Опубликовать сейчас» для мгновенной выгрузки.";
  } else if (hasFailed) {
    liveStatusTitle = `Внимание: ${failedCount} из ${totalCyclePosts} публикаций требуют перезапуска`;
    liveStatusSubtitle = "Ошибки зафиксированы. Вы можете перезапустить их все одной кнопкой или по отдельности.";
    currentActionDetail = "Используйте кнопку «↻ Перезапустить все упавшие» выше для мгновенной повторной отправки.";
  } else if (published > 0) {
    liveStatusTitle = `Все ${published} публикаций успешно завершены!`;
    liveStatusSubtitle = `Следующее автоматическое окно публикации: ${ap.status === "active" && ap.nextWindowAt ? formatWindow(ap.nextWindowAt, ap.timezone) : "по расписанию"}`;
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar
        title={ap.name}
        subtitle={`Проект «${ap.project.name}» · ${ap.publishTimes.join(", ")} (${ap.timezone})`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <AutopilotStatusBadge status={ap.status} />

            {/* Быстрая кнопка перезапуска упавших публикаций в шапке */}
            {failedCount > 0 && (
              <Button
                size="sm"
                variant="danger"
                loading={busy === "retry-failed"}
                onClick={() => act("retry-failed", () => autopilotApi.retryFailed(id))}
              >
                ↻ Перезапустить упавшие ({failedCount})
              </Button>
            )}

            {ap.status === "active" ? (
              <>
                <Button size="sm" variant="outline" loading={busy === "produce"} onClick={() => act("produce", () => autopilotApi.produceNow(id))}>
                  Смонтировать сейчас
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy === "publish"}
                  disabled={readyVariants === 0}
                  onClick={() => act("publish", () => autopilotApi.publishNow(id))}
                >
                  Опубликовать сейчас
                </Button>
                <Button size="sm" variant="secondary" loading={busy === "pause"} onClick={() => act("pause", () => autopilotApi.pause(id))}>
                  Пауза
                </Button>
              </>
            ) : (
              <Button size="sm" variant="primary" loading={busy === "activate"} onClick={() => act("activate", () => autopilotApi.activate(id))}>
                {ap.status === "draft" ? "Запустить" : "Возобновить"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
              {editing ? "Закрыть настройки" : "Настройки"}
            </Button>
          </div>
        }
      />

      <div className="flex-1 overflow-auto p-4 sm:p-6 space-y-5 animate-slide-up">
        {notice && (
          <p
            className={cn(
              "rounded-lg px-3 py-2 text-sm",
              notice.tone === "ok" && "bg-success/10 text-success",
              notice.tone === "warn" && "bg-warning/10 text-warning",
              notice.tone === "err" && "bg-danger/10 text-danger"
            )}
          >
            {notice.text}
          </p>
        )}

        {(ap.status === "error" || ap.lastError) && (
          <div
            className={cn(
              "rounded-xl border px-4 py-3 text-sm",
              ap.status === "error" ? "border-danger/40 bg-danger/10 text-danger" : "border-warning/30 bg-warning/10 text-warning"
            )}
          >
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

        {farmProxy && !farmProxy.configured && (
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
            AstroProxy не подключен в Стойке плат — публикации могут быть заблокированы без мобильного прокси.{" "}
            <Link href="/farm" className="underline hover:text-warning/80">
              Настроить AstroProxy
            </Link>
            .
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
            {/* ── ЖИВОЙ ЦЕНТР УПРАВЛЕНИЯ И МОНИТОРИНГА (LIVE PROGRESS BAR) ────────────────── */}
            <Card className="border-brand-500/30 bg-surface-1/95 backdrop-blur shadow-md">
              <CardContent className="p-4 sm:p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {/* Пульсирующий индикатор живого статуса */}
                    <span className="relative flex h-3.5 w-3.5 shrink-0">
                      <span
                        className={cn(
                          "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                          isPublishing ? "bg-brand-400" : hasFailed ? "bg-danger" : isProducing ? "bg-info" : "bg-success"
                        )}
                      />
                      <span
                        className={cn(
                          "relative inline-flex rounded-full h-3.5 w-3.5",
                          isPublishing ? "bg-brand-500" : hasFailed ? "bg-danger" : isProducing ? "bg-info" : "bg-success"
                        )}
                      />
                    </span>
                    <div>
                      <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
                        {liveStatusTitle}
                      </h2>
                      <p className="text-xs text-text-secondary">{liveStatusSubtitle}</p>
                    </div>
                  </div>

                  {/* Быстрые кнопки ручного регулирования */}
                  <div className="flex flex-wrap items-center gap-2">
                    {failedCount > 0 && (
                      <Button
                        size="sm"
                        variant="primary"
                        className="bg-danger hover:bg-danger/90 text-white font-medium"
                        loading={busy === "retry-failed"}
                        onClick={() => act("retry-failed", () => autopilotApi.retryFailed(id))}
                      >
                        ↻ Перезапустить все упавшие ({failedCount})
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      loading={busy === "publish"}
                      disabled={readyVariants === 0}
                      onClick={() => act("publish", () => autopilotApi.publishNow(id))}
                    >
                      ▶ Опубликовать сейчас
                    </Button>
                    <Link href="/farm" className="text-xs text-brand-400 hover:underline px-2 py-1">
                      📱 Стойка плат ↗
                    </Link>
                  </div>
                </div>

                {/* Реальный прогресс-бар с сегментами */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-text-primary">
                      Прогресс публикаций цикла: {published} из {totalCyclePosts} ({progressPercent}%)
                    </span>
                    <div className="flex flex-wrap items-center gap-3 text-2xs">
                      <span className="text-success font-medium">✓ Опубликовано: {published}</span>
                      {publishingCount > 0 && (
                        <span className="text-brand-400 font-medium animate-pulse">● В процессе: {publishingCount}</span>
                      )}
                      {scheduledCount > 0 && (
                        <span className="text-text-tertiary">В очереди: {scheduledCount}</span>
                      )}
                      {failedCount > 0 && (
                        <span className="text-danger font-medium">✕ Ошибок: {failedCount}</span>
                      )}
                    </div>
                  </div>

                  {/* Полоса прогресса */}
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-3 flex">
                    {published > 0 && (
                      <div
                        className="bg-success transition-all duration-500 ease-out"
                        style={{ width: `${(published / totalCyclePosts) * 100}%` }}
                        title={`Опубликовано: ${published}`}
                      />
                    )}
                    {publishingPosts.length > 0 && (
                      <div
                        className="bg-brand-500 animate-pulse transition-all duration-300"
                        style={{ width: `${(publishingPosts.length / totalCyclePosts) * 100}%` }}
                        title={`В процессе: ${publishingPosts.length}`}
                      />
                    )}
                    {failedPosts.length > 0 && (
                      <div
                        className="bg-danger transition-all duration-500"
                        style={{ width: `${(failedPosts.length / totalCyclePosts) * 100}%` }}
                        title={`Ошибок: ${failedPosts.length}`}
                      />
                    )}
                    {scheduledPosts.length > 0 && (
                      <div
                        className="bg-surface-2 transition-all duration-500"
                        style={{ width: `${(scheduledPosts.length / totalCyclePosts) * 100}%` }}
                        title={`В очереди: ${scheduledPosts.length}`}
                      />
                    )}
                  </div>
                </div>

                {/* Живая строка текущего действия */}
                {currentActionDetail && (
                  <div className="rounded-lg bg-surface-2/95 border border-brand-500/30 px-3 py-2 text-xs flex items-center justify-between gap-2 shadow-inner">
                    <div className="flex items-center gap-2 truncate">
                      <span className="h-2 w-2 rounded-full bg-brand-400 shrink-0 animate-ping" />
                      <span className="font-mono text-2xs text-brand-400 font-semibold uppercase tracking-wider">
                        {isPublishing ? "ИИ-ПУБЛИКАЦИЯ:" : "СЕЙЧАС:"}
                      </span>
                      <span className="text-text-primary truncate font-medium">{currentActionDetail}</span>
                    </div>
                    <span className="text-2xs text-text-tertiary shrink-0 flex items-center gap-1.5 font-mono">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                      онлайн 2.5с
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Pipeline strip ───────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
              <Flow label="Исходники" value={sources.total} sub={`${sources.fresh} ещё не использованы`} tone={sources.total ? undefined : "bad"} />
              <Flow label="В производстве" value={inFlight.length} sub={inFlight.length ? stageSummary(inFlight) : "ожидает спроса"} />
              <Flow label="Копий готово" value={readyVariants} sub="в буфере к публикации" tone={readyVariants ? "ok" : undefined} />
              <Flow label="Телефоны" value={`${okPhones}/${accounts.length}`} sub="готовы публиковать" tone={okPhones ? "ok" : "bad"} />
              <Flow
                label="Прокси стойки"
                value={farmProxy?.configured ? `${farmProxy.balance != null ? `$${farmProxy.balance.toFixed(2)}` : "Подключен"}` : "Не настроен"}
                sub={
                  farmProxy?.configured
                    ? `${farmProxy.mode === "shared_sequential" ? "Shared Sequential" : farmProxy.mode === "private_parallel" ? "Private Parallel" : "AstroProxy"} · ротация IP`
                    : "Требуется в /farm"
                }
                tone={farmProxy?.configured ? "ok" : "bad"}
              />
              <Flow
                label="Следующее окно"
                value={
                  ap.status === "active" && ap.nextWindowAt
                    ? new Date(ap.nextWindowAt).toLocaleTimeString("ru-RU", { timeZone: ap.timezone, hour: "2-digit", minute: "2-digit" })
                    : "—"
                }
                sub={ap.status === "active" && ap.nextWindowAt ? formatWindow(ap.nextWindowAt, ap.timezone) : ap.status === "active" ? "вычисляется…" : "автопилот не запущен"}
              />
            </div>

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
              <div className="space-y-5 min-w-0">
                {/* ── Batches ────────────────────────────────────────────── */}
                <section className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-semibold text-text-primary">Монтажи</h3>
                    <span className="text-xs text-text-tertiary">
                      всего готово: {ap.montagesProduced} · копий: {ap.variantsProduced}
                    </span>
                  </div>
                  {batches.length === 0 ? (
                    <Card>
                      <CardContent className="p-6 text-center text-sm text-text-tertiary">
                        {ap.status === "active" ? "Первый монтаж стартует в течение минуты…" : "Запустите автопилот — монтажи появятся здесь."}
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="space-y-2">
                      {batches.map((b) => (
                        <BatchRow key={b.id} b={b} />
                      ))}
                    </div>
                  )}
                </section>

                {/* ── Posts (Публикации с кнопками повтора и деталями) ────── */}
                <section className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-text-primary">Публикации</h3>
                      {isPublishing && <Badge variant="brand" className="animate-pulse text-2xs">Идёт выгрузка</Badge>}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-text-tertiary">
                        всего: {liveProgress?.totalPosts ?? ap.postsScheduled} · опубликовано: {published}
                      </span>
                      {failedCount > 0 && (
                        <Button
                          size="xs"
                          variant="danger"
                          loading={busy === "retry-failed"}
                          onClick={() => act("retry-failed", () => autopilotApi.retryFailed(id))}
                        >
                          ↻ Перезапустить все {failedCount}
                        </Button>
                      )}
                    </div>
                  </div>

                  {posts.length === 0 ? (
                    <Card>
                      <CardContent className="p-6 text-center text-sm text-text-tertiary">
                        Посты появятся после первого окна публикации.
                      </CardContent>
                    </Card>
                  ) : (
                    <Card>
                      <CardContent className="divide-y divide-border p-0">
                        {posts.map((p) => {
                          const isUnconfirmed = p.status === "published" && Boolean((p.error ?? p.publishJob?.error)?.includes("появление в профиле ожидается"));
                          const isFailed = p.status === "failed" || p.status === "skipped" || isUnconfirmed;
                          const isPublishingThis = p.status === "publishing";
                          const errText = p.error ?? p.publishJob?.error;

                          return (
                            <div key={p.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2/40 transition-colors">
                              <div className="flex items-center gap-3 min-w-0 flex-1">
                                <div className="h-12 w-8 shrink-0 overflow-hidden rounded bg-surface-2 relative">
                                  {p.thumbnailUrl ? (
                                    <img src={p.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                                  ) : (
                                    <div className="h-full w-full flex items-center justify-center text-2xs text-text-tertiary">▶</div>
                                  )}
                                  {isPublishingThis && (
                                    <div className="absolute inset-0 bg-brand-500/20 animate-pulse flex items-center justify-center" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 truncate text-sm text-text-primary font-medium">
                                    <span>{p.socialAccount.accountName}</span>
                                    <span className="text-2xs text-text-tertiary font-normal">
                                      {p.socialAccount.platform} · {p.socialAccount.deviceId ? (
                                        <Link href="/farm" className="hover:text-brand-400 underline" title="Открыть плату в Стойке">
                                          тел. {p.socialAccount.deviceId.slice(0, 10)}...
                                        </Link>
                                      ) : (
                                        "тел. —"
                                      )}
                                    </span>
                                  </div>
                                  <div className="truncate text-2xs text-text-tertiary">
                                    копия #{p.uniqueVariant.variantIndex + 1}
                                    {p.publishedAt
                                      ? ` · опубликовано ${relativeTime(p.publishedAt)}`
                                      : p.scheduledAt
                                      ? ` · запланировано ${relativeTime(p.scheduledAt)}`
                                      : ""}
                                  </div>
                                  {errText && (
                                    <div className="text-2xs text-danger/90 mt-0.5 max-w-xl break-words" title={errText}>
                                      {errText}
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                                {/* Кнопка точечного перезапуска конкретного упавшего поста */}
                                {isFailed && (
                                  <Button
                                    size="xs"
                                    variant="outline"
                                    className="border-danger/40 text-danger hover:bg-danger/10 text-xs h-7 px-2"
                                    loading={busy === `retry-${p.id}`}
                                    onClick={() => act(`retry-${p.id}`, () => autopilotApi.retryPost(id, p.id))}
                                  >
                                    ↻ Повторить
                                  </Button>
                                )}
                                {isUnconfirmed ? (
                                  <Badge variant="warning" dot className="text-xs">
                                    Не подтверждено
                                  </Badge>
                                ) : (
                                  <StatusBadge status={p.status} />
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </CardContent>
                    </Card>
                  )}
                </section>
              </div>

              <div className="space-y-5">
                {/* ── Phones ─────────────────────────────────────────────── */}
                <section className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-semibold text-text-primary">Телефоны</h3>
                    <Link href="/farm" className="text-xs text-brand-400 hover:underline">
                      Управление стойкой ↗
                    </Link>
                  </div>
                  <Card>
                    <CardContent className="max-h-72 space-y-1.5 overflow-auto p-3">
                      {accounts.length === 0 && <p className="text-xs text-text-tertiary">Нет аккаунтов с методом «телефон» в охвате.</p>}
                      {accounts.map((a) => (
                        <div key={a.id} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate text-text-secondary" title={a.accountName}>
                            {a.accountName} <span className="text-text-tertiary">· {a.platform}</span>
                            {a.deviceId && (
                              <Link href="/farm" className="text-text-tertiary hover:text-brand-400 underline">
                                {" "}· {a.deviceId.slice(0, 8)}...
                              </Link>
                            )}
                          </span>
                          {a.ok ? (
                            <Badge variant="success">готов{a.proxyHost ? ` · ${a.proxyHost}` : ""}</Badge>
                          ) : (
                            <span className="truncate text-2xs text-danger" title={a.blockers.join(", ")}>
                              {a.blockers.join(", ")}
                            </span>
                          )}
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
                      {runs.map((r) => (
                        <RunRow key={r.id} r={r} />
                      ))}
                    </CardContent>
                  </Card>
                </section>

                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={async () => {
                    if (!confirm(`Удалить автопилот «${ap.name}»? Уже созданные ролики и посты останутся.`)) return;
                    await autopilotApi.remove(id);
                    router.push("/autopilot");
                  }}
                >
                  Удалить автопилот
                </Button>
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
        <div
          className={cn(
            "text-2xl font-semibold tabular-nums",
            tone === "ok" ? "text-success" : tone === "bad" ? "text-danger" : "text-text-primary"
          )}
        >
          {value}
        </div>
        <div className="truncate text-2xs text-text-tertiary" title={sub}>
          {sub}
        </div>
      </CardContent>
    </Card>
  );
}

function stageSummary(batches: AutopilotBatch[]): string {
  const labels: Record<string, string> = {
    pending: "в очереди",
    scripting: "сценарий",
    analyzing: "раскадровка",
    rendering: "рендер",
    uniquifying: "уникализация",
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
                  <div
                    className={cn(
                      "h-1.5 rounded-full",
                      failed
                        ? "bg-danger/30"
                        : i < idx || b.status === "ready"
                        ? "bg-success"
                        : i === idx
                        ? "bg-brand-500 animate-pulse"
                        : "bg-surface-3"
                    )}
                  />
                  <div className={cn("mt-0.5 truncate text-2xs", i === idx && !failed ? "text-brand-400 font-medium" : "text-text-tertiary")}>
                    {s.label}
                  </div>
                </div>
              ))}
            </div>
            {b.uniquify && (
              <div className="text-2xs text-text-tertiary">
                Копии: {b.uniquify.completedCount}/{b.uniquify.variantCount}
                {b.uniquify.failedCount ? ` · ошибок ${b.uniquify.failedCount}` : ""}
              </div>
            )}
            {b.error && <div className="text-xs text-danger">{b.error}</div>}
            <div className="flex flex-wrap gap-3 text-2xs">
              {b.script && (
                <button type="button" className="text-brand-400 hover:underline" onClick={() => setOpen((v) => !v)}>
                  {open ? "скрыть сценарий" : "сценарий"}
                </button>
              )}
              {b.editProjectId && (
                <Link href={`/editor/${b.editProjectId}`} className="text-text-tertiary hover:text-brand-400">
                  монтаж ↗
                </Link>
              )}
              {b.uniquifyJobId && (
                <Link href={`/uniquify/jobs/${b.uniquifyJobId}`} className="text-text-tertiary hover:text-brand-400">
                  копии ↗
                </Link>
              )}
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
    subtitleStyles: ap.subtitleStyles?.length ? ap.subtitleStyles : [ap.subtitleStyle],
    smartCrop: ap.smartCrop,
    bgmKeys: ap.bgmKeys,
    productInfo: ap.productInfo ?? "",
    productArticle: ap.productArticle ?? "",
    scriptStyles: ap.scriptStyles,
    scriptEvery: ap.scriptEvery ?? 1,
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

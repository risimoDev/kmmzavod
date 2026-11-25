"use client";

import { useEffect, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { BarChart3, Eye, Film, RefreshCw, Users } from "lucide-react";
import { TopBar } from "@/components/layout/AppShell";
import { Badge, Button, LoadingSpinner } from "@/components/ui/primitives";
import { apiFetch } from "@/lib/api";

const platforms = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube_shorts: "YouTube Shorts",
  postbridge: "PostBridge",
} as const;

const statuses = {
  pending: "В очереди",
  scheduled: "Запланировано",
  uploading: "Загружается",
  published: "Опубликовано",
  failed: "Ошибка",
} as const;

interface Profile {
  collectedAt: string;
  posts: number | null;
  withViews: number;
  views: number | null;
  tiles: { index: number; views: number | null; pinned: boolean }[];
}

interface Account {
  id: string;
  platform: keyof typeof platforms;
  accountName: string;
  isActive: boolean;
  followers: number | null;
  statsAt: string | null;
  accountGroup: { name: string } | null;
  published: number;
  scheduled: number;
  failed: number;
  inProgress: number;
  verified: number;
  withViews: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  canCollect: boolean;
  profile: Profile | null;
}

type Metrics = Record<"views" | "likes" | "comments", number | null>;
type Engagement = Record<"stayed" | "averageViewed" | "completed" | "shares" | "saves", number | null>;

interface Post extends Metrics {
  id: string;
  socialAccountId: string;
  title: string;
  status: keyof typeof statuses;
  createdAt: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  verifiedAt: string | null;
  metricsAt: string | null;
  needsReview: boolean;
  engagement: Engagement | null;
}

interface AnalyticsData {
  canEdit: boolean;
  accounts: Account[];
  posts: Post[];
  page: number;
  pageSize: number;
  totalPosts: number;
}

const number = new Intl.NumberFormat("ru-RU");
const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" });
const formatNumber = (value: number | null) => value === null ? "—" : number.format(value);
const formatDate = (value: string | null) => value ? date.format(new Date(value)) : "—";
const fmtAccount = (a: Account) => `${a.accountName} · ${platforms[a.platform]}`;
const numericTotal = (values: (number | null)[]) => values.some((v) => v !== null)
  ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;

const fieldClass = "h-9 min-w-0 rounded-md border border-border bg-surface-0 px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const cardClass = "rounded-xl border border-border bg-surface-1";
const columnClass = "px-4 py-3 text-left font-medium whitespace-nowrap";
const cellClass = "px-4 py-3 tabular-nums whitespace-nowrap";
const metricFields = { views: "Просмотры", likes: "Лайки", comments: "Комментарии" } as const;
const metricKeys = Object.keys(metricFields) as (keyof Metrics)[];
const engagementFields = {
  stayed: { label: "Остались смотреть", percent: true, max: 100 },
  averageViewed: { label: "Средний процент просмотра", percent: true },
  completed: { label: "Досмотрели", percent: true, max: 100 },
  shares: { label: "Поделились", percent: false, max: 2147483647 },
  saves: { label: "Сохранили", percent: false, max: 2147483647 },
} satisfies Record<keyof Engagement, { label: string; percent: boolean; max?: number }>;
const engagementKeys = Object.keys(engagementFields) as (keyof Engagement)[];

function MetricsForm({ post, onSaved, onClose }: { post: Post; onSaved: () => void; onClose: () => void }) {
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const readValue = (key: string) => {
      const value = form.get(key);
      return value === "" || value === null ? null : Number(value);
    };
    const values = Object.fromEntries(metricKeys.map((key) => [key, readValue(key)]));
    const engagement = Object.fromEntries(engagementKeys.map((key) => [key, readValue(key)]));
    setSaving(true);
    setError(undefined);
    try {
      await apiFetch<void>(`/api/v1/analytics/posts/${post.id}/metrics`, { method: "PATCH", body: JSON.stringify({ ...values, engagement }) });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className={`${cardClass} fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 shadow-xl`}>
          <Dialog.Title className="font-semibold text-text-primary">Метрики публикации</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">{post.title}</Dialog.Description>
          <form onSubmit={save} className="mt-4 space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              {metricKeys.map((key) => (
                <label key={key} className="grid gap-1 text-xs text-text-secondary">
                  {metricFields[key]}
                  <input name={key} type="number" min="0" max="2147483647" step="1" placeholder="Нет данных"
                    defaultValue={post[key] ?? ""} className={`${fieldClass} w-28`} />
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {engagementKeys.map((key) => {
                const field = engagementFields[key];
                return <label key={key} className="grid gap-1 text-xs text-text-secondary">
                  {field.label}{field.percent && ", %"}
                  <input name={key} type="number" min="0" max={"max" in field ? field.max : undefined} step={field.percent ? "0.01" : "1"}
                    placeholder="Нет данных" defaultValue={post.engagement?.[key] ?? ""} className={`${fieldClass} w-28`} />
                </label>;
              })}
            </div>
            <div className="flex gap-2">
              <Button variant="primary" type="submit" loading={saving}>Сохранить</Button>
              <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Отмена</Button>
            </div>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [refresh, setRefresh] = useState(0);
  const [platform, setPlatform] = useState("");
  const [accountId, setAccountId] = useState("");
  const [period, setPeriod] = useState("all");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);
  const [collecting, setCollecting] = useState<string>();
  const [editing, setEditing] = useState<Post>();

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ period, sort, page: String(page) });
    if (platform) query.set("platform", platform);
    if (accountId) query.set("accountId", accountId);
    if (status) query.set("status", status);
    setLoading(true);
    setError(undefined);
    apiFetch<AnalyticsData>(`/api/v1/analytics/accounts?${query}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [platform, accountId, period, status, sort, page, refresh]);

  const selected = data?.accounts.find((a) => a.id === accountId);
  const accountMap = new Map(data?.accounts.map((a) => [a.id, a]));
  const scope = selected ? [selected] : data?.accounts ?? [];
  const totalPublished = scope.reduce((sum, a) => sum + a.published, 0);
  const coverage = scope.reduce((sum, a) => sum + a.withViews, 0);
  const sumFollowers = numericTotal(scope.map((a) => a.followers));
  const maxPage = data ? Math.max(1, Math.ceil(data.totalPosts / data.pageSize)) : 1;

  function selectAccount(id: string) {
    setAccountId(id);
    setPage(1);
    setEditing(undefined);
  }

  async function collect(account: Account) {
    setCollecting(account.id);
    setNotice(undefined);
    try {
      await apiFetch<void>(`/api/v1/analytics/accounts/${account.id}/collect`, { method: "POST" });
      setNotice({ text: `Данные профиля ${account.accountName} обновлены` });
      setRefresh((n) => n + 1);
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
    } finally {
      setCollecting(undefined);
    }
  }

  const stats = [
    { icon: Users, label: "Аккаунты", value: scope.length, detail: `${formatNumber(scope.filter((a) => a.isActive).length)} активных` },
    { icon: Film, label: "Опубликовано через сервис", value: totalPublished, detail: `${formatNumber(scope.reduce((sum, a) => sum + a.verified, 0))} подтверждено на платформе` },
    { icon: Eye, label: "Просмотры публикаций", value: numericTotal(scope.map((a) => a.views)), detail: `Есть данные у ${formatNumber(coverage)} из ${formatNumber(totalPublished)} видео` },
    { icon: BarChart3, label: "Подписчики", value: sumFollowers, detail: `Есть данные у ${formatNumber(scope.filter((a) => a.followers !== null).length)} из ${formatNumber(scope.length)} аккаунтов` },
  ];

  return (
    <>
      <TopBar title="Аналитика аккаунтов" actions={
        <Button variant="outline" size="sm" loading={loading} icon={<RefreshCw size={14} />} onClick={() => setRefresh((n) => n + 1)}>
          Обновить
        </Button>
      } />
      <main className="min-w-0 flex-1 space-y-5 p-4 sm:p-6" aria-busy={loading}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
            Платформа
            <select className={fieldClass} value={platform} onChange={(e) => { setPlatform(e.target.value); selectAccount(""); }}>
              <option value="">Все платформы</option>
              {Object.entries(platforms).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
            Аккаунт
            <select className={fieldClass} value={accountId} onChange={(e) => selectAccount(e.target.value)}>
              <option value="">Все аккаунты</option>
              {data?.accounts.filter((a) => !platform || a.platform === platform).map((a) => (
                <option key={a.id} value={a.id}>{fmtAccount(a)}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
            Период публикаций
            <select className={fieldClass} value={period} onChange={(e) => { setPeriod(e.target.value); setPage(1); setEditing(undefined); }}>
              <option value="all">За всё время</option>
              <option value="7">Последние 7 дней</option>
              <option value="30">Последние 30 дней</option>
              <option value="90">Последние 90 дней</option>
            </select>
          </label>
        </div>

        {error && <p role="alert" className={`${cardClass} px-4 py-3 text-sm text-danger`}>{error}</p>}
        {notice && <p role={notice.error ? "alert" : "status"} className={`${cardClass} px-4 py-3 text-sm ${notice.error ? "text-danger" : "text-success"}`}>{notice.text}</p>}
        {loading && <div className="flex justify-center p-8"><LoadingSpinner size={28} /></div>}

        {data && !loading && !error && <>
          <section aria-label="Сводка" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {stats.map(({ icon: Icon, ...stat }) => (
              <div key={stat.label} className={`${cardClass} min-w-0 p-3.5 sm:p-4`}>
                <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                  <Icon className="shrink-0 text-brand-400" size={16} aria-hidden />{stat.label}
                </div>
                <p className="mt-2 text-2xl font-semibold tabular-nums text-text-primary">{formatNumber(stat.value)}</p>
                <p className="mt-1 text-xs text-text-tertiary">{stat.detail}</p>
              </div>
            ))}
          </section>

          <section className={cardClass} aria-labelledby="account-table-title">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
              <h2 id="account-table-title" className="font-semibold text-text-primary">Аккаунты</h2>
              {selected && <Button variant="ghost" size="sm" onClick={() => selectAccount("")}>Показать все</Button>}
            </div>
            {scope.length ? <div className="overflow-x-auto">
              <table className="w-full text-sm text-text-secondary">
                <thead className="bg-surface-2/50 text-xs">
                  <tr>{["Аккаунт", "Видео сервиса", "Просмотры публикаций", "Лайки", "Комментарии", "Подписчики", "Запланировано", "Ошибки", "В работе", "Снимок профиля"].map((label) => <th key={label} scope="col" className={columnClass}>{label}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {scope.map((a) => (
                    <tr key={a.id}>
                      <th scope="row" className={`${cellClass} text-left font-medium`}>
                        <button type="button" onClick={() => selectAccount(a.id)} className="max-w-52 truncate text-brand-400 hover:underline">{a.accountName}</button>
                        <p className="text-xs text-text-tertiary">{platforms[a.platform]}{a.accountGroup && ` · ${a.accountGroup.name}`}</p>
                        {!a.isActive && <Badge variant="neutral">Отключён</Badge>}
                      </th>
                      <td className={cellClass}>{formatNumber(a.published)}</td>
                      <td className={cellClass}>{formatNumber(a.views)}{a.withViews > 0 && <p className="text-xs text-text-tertiary">{a.withViews} видео с данными</p>}</td>
                      <td className={cellClass}>{formatNumber(a.likes)}</td>
                      <td className={cellClass}>{formatNumber(a.comments)}</td>
                      <td className={cellClass}>{formatNumber(a.followers)}</td>
                      <td className={cellClass}>{formatNumber(a.scheduled)}</td>
                      <td className={cellClass}>{formatNumber(a.failed)}</td>
                      <td className={cellClass}>{formatNumber(a.inProgress)}</td>
                      <td className={cellClass}>
                        {a.profile?.views != null && <p>{formatNumber(a.profile.views)} просмотров · {formatNumber(a.profile.withViews)} видимых видео</p>}
                        {a.canCollect && <Button variant="outline" size="xs" disabled={!!collecting} loading={collecting === a.id} onClick={() => collect(a)}>Собрать с телефона</Button>}
                        <p className="text-xs text-text-tertiary">{a.statsAt ? formatDate(a.statsAt) : "Нет снимка"}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div> : <div className="px-4 py-8 text-center text-sm text-text-secondary">
              {platform ? "На этой платформе нет подключённых аккаунтов." : <>Добавьте аккаунт в <Link className="text-brand-400 hover:underline" href="/farm">Account Farm</Link>.</>}
            </div>}
          </section>

          {selected && <section className={`${cardClass} space-y-3 px-4 py-4`} aria-labelledby="profile-title">
            <h2 id="profile-title" className="font-semibold text-text-primary">Профиль {selected.accountName}</h2>
            {selected.profile ? <>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-text-secondary">
                <span>Подписчики <strong className="text-text-primary">{formatNumber(selected.followers)}</strong></span>
                <span>Постов в профиле <strong className="text-text-primary">{formatNumber(selected.profile.posts)}</strong></span>
                <span>Просмотры видимых видео <strong className="text-text-primary">{formatNumber(selected.profile.views)}</strong>{selected.profile.withViews > 0 && ` · ${selected.profile.withViews} видео`}</span>
                <span className="text-text-tertiary">{formatDate(selected.profile.collectedAt)}</span>
              </div>
              {selected.profile.tiles.length > 0 && <ul aria-label="Видео, видимые в профиле" className="flex flex-wrap gap-2">
                {selected.profile.tiles.map((tile) => (
                  <li key={tile.index} className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary">
                    №{tile.index + 1} · {formatNumber(tile.views)}{tile.pinned && " · закреплено"}
                  </li>
                ))}
              </ul>}
            </> : <p className="text-sm text-text-secondary">{selected.canCollect ? "Нажмите «Собрать с телефона», чтобы получить снимок профиля." : "Снимок профиля пока недоступен."}</p>}
          </section>}

          <section className={cardClass} aria-labelledby="posts-title">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
              <h2 id="posts-title" className="font-semibold text-text-primary">Публикации <span className="text-sm font-normal text-text-tertiary">{formatNumber(data.totalPosts)}</span></h2>
              <div className="flex flex-wrap gap-2">
                <select aria-label="Статус публикации" className={fieldClass} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); setEditing(undefined); }}>
                  <option value="">Все статусы</option>
                  {Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
                <select aria-label="Сортировка публикаций" className={fieldClass} value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
                  <option value="recent">Сначала новые</option><option value="views">По просмотрам</option>
                </select>
              </div>
            </div>
            {editing && <MetricsForm key={editing.id} post={editing} onClose={() => setEditing(undefined)} onSaved={() => {
              setEditing(undefined); setNotice({ text: "Метрики публикации сохранены" }); setRefresh((n) => n + 1);
            }} />}
            {data.posts.length ? <div className="overflow-x-auto">
              <table className="w-full text-sm text-text-secondary">
                <thead className="bg-surface-2/50 text-xs">
                  <tr>{["Видео", "Аккаунт", "Статус", "Дата", "Просмотры", "Лайки", "Комментарии", "Удержание и реакции", "Замер", ...(data.canEdit ? ["Действие"] : [])].map((label) => <th key={label} scope="col" className={columnClass}>{label}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.posts.map((post) => {
                    const account = accountMap.get(post.socialAccountId);
                    const recorded = engagementKeys.filter((key) => post.engagement?.[key] != null);
                    return <tr key={post.id}>
                      <th scope="row" className={`${cellClass} max-w-60 truncate text-left font-medium text-text-primary`} title={post.title}>{post.title}</th>
                      <td className={cellClass}>{account ? fmtAccount(account) : "—"}</td>
                      <td className={cellClass}>
                        <Badge variant={post.status === "failed" ? "danger" : post.status === "published" ? "success" : "neutral"}>{statuses[post.status]}</Badge>
                        {post.verifiedAt && <p className="text-xs text-success">Подтверждено</p>}
                        {post.needsReview && <p className="text-xs text-warning">Требует проверки</p>}
                      </td>
                      <td className={cellClass}>{formatDate(post.publishedAt ?? post.scheduledAt ?? post.createdAt)}</td>
                      <td className={cellClass}>{formatNumber(post.views)}</td>
                      <td className={cellClass}>{formatNumber(post.likes)}</td>
                      <td className={cellClass}>{formatNumber(post.comments)}</td>
                      <td className={`${cellClass} text-xs`}>
                        {recorded.length ? recorded.map((key) => <p key={key}>
                          {engagementFields[key].label} · {formatNumber(post.engagement?.[key] ?? null)}{engagementFields[key].percent && "%"}
                        </p>) : "—"}
                      </td>
                      <td className={cellClass}>{formatDate(post.metricsAt)}</td>
                      {data.canEdit && <td className={cellClass}>{post.status === "published" && <Button variant="ghost" size="xs" onClick={() => setEditing(post)}>Метрики</Button>}</td>}
                    </tr>;
                  })}
                </tbody>
              </table>
            </div> : <p className="px-4 py-8 text-center text-sm text-text-secondary">По выбранным фильтрам публикаций нет.</p>}
            {maxPage > 1 && <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-3 text-xs text-text-secondary">
              <Button variant="outline" size="sm" disabled={loading || data.page <= 1} onClick={() => { setPage(data.page - 1); setEditing(undefined); }}>Назад</Button>
              <span>{data.page} из {maxPage}</span>
              <Button variant="outline" size="sm" disabled={loading || data.page >= maxPage} onClick={() => { setPage(data.page + 1); setEditing(undefined); }}>Вперёд</Button>
            </div>}
          </section>
        </>}
      </main>
    </>
  );
}

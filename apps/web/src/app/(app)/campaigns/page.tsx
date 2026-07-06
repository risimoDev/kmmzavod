"use client";

/**
 * Кампании — сквозной автопилот. Список + мастер создания.
 * Фаза 1: кампания публикует готовые уникализированные варианты по расписанию
 * на пригодные аккаунты фермы. См. docs/CAMPAIGNS_PLAN.md.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button, LoadingSpinner, Badge, Card, CardContent, Input, EmptyState,
} from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime, cn } from "@/lib/utils";
import {
  campaignsApi, accountFarmApi, productsApi,
  getAccessToken,
  type Campaign, type AccountGroup, type FarmSocialAccount,
} from "@/lib/api";

const CRON_PRESETS = [
  { label: "Каждый день 12:00", value: "0 12 * * *" },
  { label: "Дважды в день 12/18", value: "0 12,18 * * *" },
  { label: "3×/день 10/14/19", value: "0 10,14,19 * * *" },
  { label: "Каждые 4 часа", value: "0 */4 * * *" },
];

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [accounts, setAccounts] = useState<FarmSocialAccount[]>([]);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => { if (!getAccessToken()) router.replace("/login"); }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, g, a] = await Promise.all([
        campaignsApi.list(),
        accountFarmApi.listGroups().catch(() => []),
        accountFarmApi.listAccounts({ isActive: true, limit: 200 }).catch(() => ({ accounts: [] as FarmSocialAccount[] })),
      ]);
      setCampaigns(c);
      setGroups(g);
      setAccounts(a.accounts);
      if (c.length === 0) setShowCreate(true);
    } catch {
      setShowCreate(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Products are optional (campaign can run without one in Phase 1).
  useEffect(() => {
    productsApi.list({ limit: 100 })
      .then((r) => setProducts(r.data.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => setProducts([]));
  }, []);

  const lifecycle = async (c: Campaign, action: "activate" | "pause" | "complete") => {
    try {
      const updated = await campaignsApi[action](c.id);
      setCampaigns((prev) => prev.map((x) => (x.id === c.id ? updated : x)));
    } catch (e: any) {
      alert(e.message ?? "Ошибка");
    }
  };

  return (
    <div className="flex flex-col h-full">
      <TopBar
        title="Кампании"
        subtitle="Сквозной автопилот: контент → ферма → публикация"
        actions={
          <Button variant={showCreate ? "secondary" : "primary"} size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Скрыть мастер" : "+ Новая кампания"}
          </Button>
        }
      />
      <div className="flex-1 overflow-auto p-6 space-y-5 animate-slide-up">
        {showCreate && (
          <CreateCampaign
            groups={groups} accounts={accounts} products={products}
            cronPresets={CRON_PRESETS}
            onCreated={(c) => { setCampaigns((p) => [c, ...p]); setShowCreate(false); }}
          />
        )}

        {loading ? (
          <div className="flex justify-center py-12"><LoadingSpinner size={28} /></div>
        ) : campaigns.length === 0 ? (
          !showCreate && <EmptyState title="Нет кампаний" description="Создайте первую кампанию-автопилот." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {campaigns.map((c) => (
              <Card key={c.id} hoverable
                className="cursor-pointer group hover:border-brand-500/40 transition-all"
                onClick={() => router.push(`/campaigns/${c.id}`)}>
                <CardContent className="p-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-medium truncate text-text-primary">{c.name}</h4>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{c.contentSource}</Badge>
                    <Badge variant="outline">{c.postsPerAccountPerDay}/акк·день</Badge>
                    {c.platforms.slice(0, 3).map((p) => <Badge key={p} variant="brand">{p}</Badge>)}
                  </div>
                  <div className="text-xs text-text-tertiary">
                    {c.postsPublished} опубл. · {c.postsFailed} ошибок
                    {c.nextRunAt && c.status === "active" && <> · next {relativeTime(c.nextRunAt)}</>}
                  </div>
                  {c.lastError && <p className="text-xs text-warning truncate">{c.lastError}</p>}
                  <div className="flex gap-1.5 pt-1" onClick={(e) => e.stopPropagation()}>
                    {c.status === "active" ? (
                      <Button variant="secondary" size="xs" onClick={() => lifecycle(c, "pause")}>Пауза</Button>
                    ) : c.status === "draft" || c.status === "paused" ? (
                      <Button variant="primary" size="xs" onClick={() => lifecycle(c, "activate")}>Запустить</Button>
                    ) : null}
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

function CreateCampaign({ groups, accounts, products, cronPresets, onCreated }: {
  groups: AccountGroup[];
  accounts: FarmSocialAccount[];
  products: { id: string; name: string }[];
  cronPresets: { label: string; value: string }[];
  onCreated: (c: Campaign) => void;
}) {
  const [name, setName] = useState("Кампания");
  const [productId, setProductId] = useState("");
  const [accountGroupId, setAccountGroupId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [postsPerDay, setPostsPerDay] = useState(1);
  const [cron, setCron] = useState(cronPresets[0].value);
  const [timezone, setTimezone] = useState("Europe/Moscow");
  const [stagger, setStagger] = useState(15);
  const [bufferDays, setBufferDays] = useState(2);
  const [hashtags, setHashtags] = useState("");
  const [dedup, setDedup] = useState(true);
  const [respectWarmup, setRespectWarmup] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readyCount = accounts.filter((a) => a.readiness?.canPublish !== false).length;

  const submit = async () => {
    if (!accountGroupId && selected.size === 0) {
      setError("Выберите группу или хотя бы один аккаунт"); return;
    }
    setSubmitting(true); setError(null);
    try {
      const c = await campaignsApi.create({
        name,
        productId: productId || undefined,
        contentSource: "uniquify",
        accountGroupId: accountGroupId || undefined,
        socialAccountIds: [...selected],
        postsPerAccountPerDay: postsPerDay,
        cronExpression: cron, timezone, staggerMinutes: stagger, bufferDays,
        hashtags: hashtags.split(/[,\s]+/).map((h) => h.trim()).filter(Boolean),
        dedupPerAccount: dedup, respectWarmup,
      });
      onCreated(c);
    } catch (e: any) {
      setError(e.message ?? "Не удалось создать кампанию");
    } finally {
      setSubmitting(false);
    }
  };

  const toggle = (id: string) => setSelected((p) => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  return (
    <Card className="shadow-elevation-2">
      <CardContent className="p-5 space-y-4">
        <h3 className="text-sm font-semibold">Новая кампания</h3>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-text-secondary">Название
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-text-secondary">Продукт (необязательно)
            <select value={productId} onChange={(e) => setProductId(e.target.value)}
              className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm">
              <option value="">— без продукта —</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>

        <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-secondary">
          Источник контента: <b className="text-text-primary">уникализация</b> — кампания публикует
          готовые уникализированные варианты. Готовы к постингу сейчас: <b className="text-success">{readyCount}</b> аккаунтов.
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-text-secondary">Группа аккаунтов
            <select value={accountGroupId} onChange={(e) => setAccountGroupId(e.target.value)}
              className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm">
              <option value="">— не использовать —</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-text-secondary">Постов на аккаунт в день
            <Input type="number" min={1} max={20} value={postsPerDay}
              onChange={(e) => setPostsPerDay(Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className="space-y-1 text-xs text-text-secondary">Буфер, дней
            <Input type="number" min={1} max={30} value={bufferDays}
              onChange={(e) => setBufferDays(Math.max(1, Number(e.target.value) || 2))} />
          </label>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-text-secondary">Расписание публикаций</p>
          <div className="flex flex-wrap gap-2">
            {cronPresets.map((p) => (
              <button key={p.value} type="button" onClick={() => setCron(p.value)}
                className={cn("px-2.5 py-1 rounded-lg text-xs transition-all",
                  cron === p.value ? "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30" : "bg-surface-2 text-text-secondary")}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 12,18 * * *" />
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/Moscow" />
            <label className="space-y-1 text-xs text-text-secondary">Стаггер, мин
              <Input type="number" min={1} max={1440} value={stagger}
                onChange={(e) => setStagger(Math.max(1, Number(e.target.value) || 15))} />
            </label>
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-text-secondary">Доп. аккаунты ({selected.size})</p>
          <div className="max-h-40 overflow-y-auto space-y-1 border border-border rounded-lg p-2">
            {accounts.length === 0 && <p className="text-xs text-text-tertiary p-1">Нет активных аккаунтов.</p>}
            {accounts.map((a) => {
              const blocked = a.readiness?.canPublish === false;
              return (
                <label key={a.id} className={cn("flex items-center gap-2 text-xs px-2 py-1 rounded",
                  blocked ? "opacity-60" : "hover:bg-surface-2 cursor-pointer")}>
                  <input type="checkbox" disabled={blocked} checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                  <Badge>{a.platform}</Badge>
                  <span>{a.accountName}</span>
                  {blocked && <span className="text-danger">{a.readiness?.blockers?.[0]}</span>}
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="space-y-1 text-xs text-text-secondary flex-1 min-w-[200px]">Хэштеги (через запятую)
            <Input value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="viral, reels" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input type="checkbox" checked={dedup} onChange={(e) => setDedup(e.target.checked)} /> Дедуп на аккаунт
          </label>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input type="checkbox" checked={respectWarmup} onChange={(e) => setRespectWarmup(e.target.checked)} /> Требовать warmup
          </label>
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary" onClick={submit} loading={submitting}>Создать (draft)</Button>
        </div>
      </CardContent>
    </Card>
  );
}

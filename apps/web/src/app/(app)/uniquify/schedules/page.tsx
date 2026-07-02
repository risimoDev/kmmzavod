"use client";

/**
 * Расписания автопубликации — CRON-расписания, которые каждый запуск берут
 * свежие (ещё не публиковавшиеся) готовые уникализированные варианты и
 * раздают их по аккаунтам фермы через стандартную дистрибуцию.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  LoadingSpinner,
  Badge,
  Card,
  CardContent,
  Input,
  EmptyState,
} from "@/components/ui/primitives";
import { relativeTime, cn } from "@/lib/utils";
import {
  distributeSchedulesApi,
  accountFarmApi,
  getAccessToken,
  type DistributeSchedule,
  type AccountGroup,
  type FarmSocialAccount,
} from "@/lib/api";

const CRON_PRESETS = [
  { label: "Каждый день в 12:00", value: "0 12 * * *" },
  { label: "Дважды в день (12:00, 18:00)", value: "0 12,18 * * *" },
  { label: "Три раза в день (10, 14, 19)", value: "0 10,14,19 * * *" },
  { label: "Каждые 4 часа", value: "0 */4 * * *" },
  { label: "Пн/Ср/Пт в 11:00", value: "0 11 * * 1,3,5" },
];

export default function DistributeSchedulesPage() {
  const router = useRouter();
  const [schedules, setSchedules] = useState<DistributeSchedule[]>([]);
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [accounts, setAccounts] = useState<FarmSocialAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    if (!getAccessToken()) router.replace("/login");
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sch, grp, acc] = await Promise.all([
        distributeSchedulesApi.list(),
        accountFarmApi.listGroups(),
        accountFarmApi.listAccounts({ isActive: true, limit: 200 }),
      ]);
      setSchedules(sch);
      setGroups(grp);
      setAccounts(acc.accounts);
    } catch (e: any) {
      setError(e.message ?? "Не удалось загрузить расписания");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (s: DistributeSchedule) => {
    try {
      const updated = await distributeSchedulesApi.update(s.id, { isActive: !s.isActive });
      setSchedules(prev => prev.map(x => (x.id === s.id ? updated : x)));
    } catch (e: any) {
      alert(e.message ?? "Ошибка обновления");
    }
  };

  const remove = async (s: DistributeSchedule) => {
    if (!confirm(`Удалить расписание «${s.name}»?`)) return;
    try {
      await distributeSchedulesApi.remove(s.id);
      setSchedules(prev => prev.filter(x => x.id !== s.id));
    } catch (e: any) {
      alert(e.message ?? "Ошибка удаления");
    }
  };

  return (
    <>
      <TopBar
        title="Автопубликация"
        subtitle="Расписания публикации уникализированных видео по аккаунтам фермы"
      />
      <main className="flex-1 p-6 space-y-5 animate-slide-up">
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => router.push("/uniquify")}>← Уникализация</Button>
          <Button onClick={() => setShowCreate(v => !v)}>
            {showCreate ? "Скрыть форму" : "+ Новое расписание"}
          </Button>
        </div>

        {showCreate && (
          <CreateScheduleForm
            groups={groups}
            accounts={accounts}
            onCreated={(s) => {
              setSchedules(prev => [s, ...prev]);
              setShowCreate(false);
            }}
          />
        )}

        {loading ? (
          <div className="flex justify-center py-16"><LoadingSpinner size={32} /></div>
        ) : error ? (
          <Card><CardContent className="p-6 text-center space-y-3">
            <p className="text-sm text-red-400">{error}</p>
            <Button variant="secondary" onClick={load}>Повторить</Button>
          </CardContent></Card>
        ) : schedules.length === 0 ? (
          <EmptyState
            title="Расписаний пока нет"
            description="Создайте расписание — готовые варианты будут публиковаться автоматически"
            action={<Button onClick={() => setShowCreate(true)}>+ Новое расписание</Button>}
          />
        ) : (
          <div className="space-y-3">
            {schedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                groups={groups}
                onToggle={() => toggleActive(s)}
                onDelete={() => remove(s)}
              />
            ))}
          </div>
        )}
      </main>
    </>
  );
}

function ScheduleRow({
  schedule: s,
  groups,
  onToggle,
  onDelete,
}: {
  schedule: DistributeSchedule;
  groups: AccountGroup[];
  onToggle: () => void;
  onDelete: () => void;
}) {
  const groupName = s.accountGroupId
    ? groups.find(g => g.id === s.accountGroupId)?.name ?? "группа"
    : null;
  const targets = [
    groupName ? `группа «${groupName}»` : null,
    s.socialAccountIds.length > 0 ? `${s.socialAccountIds.length} акк.` : null,
  ].filter(Boolean).join(" + ");

  return (
    <Card>
      <CardContent className="p-4 flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[220px] space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{s.name}</span>
            <Badge variant={s.isActive ? "success" : "default"}>
              {s.isActive ? "активно" : "пауза"}
            </Badge>
          </div>
          <p className="text-xs text-text-secondary">
            <code className="bg-surface-2 px-1.5 py-0.5 rounded">{s.cronExpression}</code>
            {" · "}{s.timezone}{" · "}{targets || "цели не заданы"}
            {" · "}{s.variantsPerAccount} видео/акк · стаггер {s.staggerMinutes} мин
          </p>
          <p className="text-xs text-text-secondary">
            Запусков: {s.totalRuns}
            {s.lastRunAt && <> · последний {relativeTime(s.lastRunAt)}</>}
            {s.nextRunAt && s.isActive && <> · следующий {relativeTime(s.nextRunAt)}</>}
          </p>
          {s.lastError && (
            <p className="text-xs text-amber-400">Последний запуск: {s.lastError}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onToggle}>
            {s.isActive ? "Пауза" : "Возобновить"}
          </Button>
          <Button variant="ghost" onClick={onDelete}>Удалить</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateScheduleForm({
  groups,
  accounts,
  onCreated,
}: {
  groups: AccountGroup[];
  accounts: FarmSocialAccount[];
  onCreated: (s: DistributeSchedule) => void;
}) {
  const [name, setName] = useState("Автопубликация");
  const [cron, setCron] = useState(CRON_PRESETS[0].value);
  const [timezone, setTimezone] = useState("Europe/Moscow");
  const [accountGroupId, setAccountGroupId] = useState("");
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [variantsPerAccount, setVariantsPerAccount] = useState(1);
  const [staggerMinutes, setStaggerMinutes] = useState(15);
  const [hashtags, setHashtags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleAccount = (id: string) => {
    setSelectedAccounts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!accountGroupId && selectedAccounts.size === 0) {
      setError("Выберите группу аккаунтов или хотя бы один аккаунт");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const schedule = await distributeSchedulesApi.create({
        name,
        cronExpression: cron,
        timezone,
        accountGroupId: accountGroupId || undefined,
        socialAccountIds: [...selectedAccounts],
        variantsPerAccount,
        staggerMinutes,
        hashtags: hashtags.split(/[,\s]+/).map(h => h.trim()).filter(Boolean),
      });
      onCreated(schedule);
    } catch (e: any) {
      setError(e.message ?? "Не удалось создать расписание");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <h3 className="text-sm font-semibold">Новое расписание автопубликации</h3>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-text-secondary">
            Название
            <Input value={name} onChange={e => setName(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-text-secondary">
            Таймзона
            <Input value={timezone} onChange={e => setTimezone(e.target.value)} />
          </label>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-text-secondary">Расписание (cron)</p>
          <div className="flex flex-wrap gap-2">
            {CRON_PRESETS.map(p => (
              <button
                key={p.value}
                type="button"
                onClick={() => setCron(p.value)}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs transition-all",
                  cron === p.value
                    ? "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30"
                    : "bg-surface-2 text-text-secondary hover:text-text-primary"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Input value={cron} onChange={e => setCron(e.target.value)} placeholder="0 12,18 * * *" />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-text-secondary">
            Группа аккаунтов
            <select
              value={accountGroupId}
              onChange={e => setAccountGroupId(e.target.value)}
              className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value="">— не использовать —</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-text-secondary">
            Видео на аккаунт за запуск
            <Input
              type="number" min={1} max={10}
              value={variantsPerAccount}
              onChange={e => setVariantsPerAccount(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
          <label className="space-y-1 text-xs text-text-secondary">
            Стаггер между постами, мин
            <Input
              type="number" min={1} max={1440}
              value={staggerMinutes}
              onChange={e => setStaggerMinutes(Math.max(1, Number(e.target.value) || 15))}
            />
          </label>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-text-secondary">
            Дополнительные аккаунты ({selectedAccounts.size} выбрано)
          </p>
          <div className="max-h-44 overflow-y-auto space-y-1 border border-border rounded-lg p-2">
            {accounts.length === 0 && (
              <p className="text-xs text-text-secondary p-2">Нет активных аккаунтов — импортируйте их на странице фермы</p>
            )}
            {accounts.map(a => (
              <label key={a.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded hover:bg-surface-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedAccounts.has(a.id)}
                  onChange={() => toggleAccount(a.id)}
                />
                <Badge>{a.platform}</Badge>
                <span>{a.accountName}</span>
                {a.warmupStatus === "cold" && a.authMethod === "private" && (
                  <span className="text-amber-400">(не прогрет — будет пропускаться)</span>
                )}
              </label>
            ))}
          </div>
        </div>

        <label className="space-y-1 text-xs text-text-secondary block">
          Хэштеги (через запятую; если у варианта нет автогенерированных)
          <Input value={hashtags} onChange={e => setHashtags(e.target.value)} placeholder="viral, reels" />
        </label>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end">
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <LoadingSpinner size={16} /> : "Создать расписание"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

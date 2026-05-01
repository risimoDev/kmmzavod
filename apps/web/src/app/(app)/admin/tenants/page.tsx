"use client";

import { useEffect, useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { Button, Badge, Card, CardContent } from "@/components/ui/primitives";
import { adminApi, type AdminTenant, type Pagination } from "@/lib/admin-api";
import { relativeTime, cn } from "@/lib/utils";

const PLAN_COLOR: Record<string, string> = {
  starter:    "bg-surface-2 text-text-secondary",
  pro:        "bg-brand-500/15 text-brand-300",
  enterprise: "bg-amber-500/15 text-amber-300",
};

export default function AdminTenantsPage() {
  const [tenants, setTenants]       = useState<AdminTenant[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0 });
  const [loading, setLoading]       = useState(true);
  const [query, setQuery]           = useState("");
  const [plan, setPlan]             = useState("");
  const [page, setPage]             = useState(1);
  const [actionId, setActionId]     = useState<string | null>(null);

  // Credit grant modal
  const [grantTenant, setGrantTenant] = useState<AdminTenant | null>(null);
  const [grantAmount, setGrantAmount] = useState("");
  const [grantDesc, setGrantDesc]     = useState("");
  const [granting, setGranting]       = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    adminApi.getTenants({ page, search: query || undefined, plan: plan || undefined })
      .then(res => { setTenants(res.data); setPagination(res.pagination); })
      .finally(() => setLoading(false));
  }, [page, query, plan]);

  useEffect(() => { load(); }, [load]);

  const suspend = async (id: string) => {
    setActionId(id);
    try { await adminApi.suspendTenant(id); load(); }
    finally { setActionId(null); }
  };

  const reinstate = async (id: string) => {
    setActionId(id);
    try { await adminApi.reinstateTenant(id); load(); }
    finally { setActionId(null); }
  };

  const handleGrant = async () => {
    if (!grantTenant) return;
    const amt = parseInt(grantAmount, 10);
    if (isNaN(amt)) return;
    setGranting(true);
    try {
      await adminApi.grantCredits(grantTenant.id, amt, grantDesc || `Admin grant ${amt}`);
      setGrantTenant(null);
      setGrantAmount("");
      setGrantDesc("");
      load();
    } finally {
      setGranting(false);
    }
  };

  const totalPages = Math.ceil(pagination.total / pagination.limit);

  return (
    <div className="p-6 space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-3">
        <input value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}
          placeholder="Поиск по имени, slug…"
          className="h-8 px-3 text-xs rounded-lg bg-surface-1 border border-border text-text-primary
            placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/50 w-full sm:w-64" />
        <select value={plan} onChange={e => { setPlan(e.target.value); setPage(1); }}
          className="h-8 px-2.5 text-xs rounded-lg bg-surface-1 border border-border text-text-secondary focus:outline-none">
          <option value="">Все планы</option>
          <option value="starter">Starter</option>
          <option value="pro">Pro</option>
          <option value="enterprise">Enterprise</option>
        </select>
        <span className="ml-auto text-xs text-text-tertiary">{pagination.total.toLocaleString()} тенантов</span>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-1">
                  {["Тенант", "Slug", "План", "Польз.", "Видео", "Баланс", "Статус", "Создан", "Действия"].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs text-text-tertiary font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {loading && tenants.length === 0
                    ? Array.from({ length: 8 }).map((_, i) => (
                        <tr key={i} className="border-b border-border/30">
                          {Array.from({ length: 9 }).map((_, j) => (
                            <td key={j} className="px-4 py-3"><div className="h-3 rounded bg-surface-2 animate-pulse w-16" /></td>
                          ))}
                        </tr>
                      ))
                    : tenants.map(t => (
                        <motion.tr key={t.id} layout
                          className="border-b border-border/30 last:border-0 hover:bg-surface-1 transition-colors">
                          <td className="px-4 py-3">
                            <p className="text-xs font-medium text-text-primary">{t.name}</p>
                            <p className="text-[10px] text-text-tertiary mt-0.5">{t.id.slice(0, 8)}…</p>
                          </td>
                          <td className="px-4 py-3 text-xs font-mono text-text-tertiary">{t.slug}</td>
                          <td className="px-4 py-3">
                            <span className={cn("px-2 py-0.5 rounded text-xs font-medium capitalize", PLAN_COLOR[t.plan] ?? PLAN_COLOR.starter)}>
                              {t.plan}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs tabular-nums text-text-secondary">{t._count.users}</td>
                          <td className="px-4 py-3 text-xs tabular-nums text-text-secondary">{t._count.videos}</td>
                          <td className="px-4 py-3 text-xs tabular-nums text-text-primary">{t.credits.toLocaleString()}</td>
                          <td className="px-4 py-3">
                            {t.isActive
                              ? <span className="text-xs text-success">Активен</span>
                              : <span className="text-xs text-danger">Заморожен</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-text-tertiary">{relativeTime(t.createdAt)}</td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1.5">
                              <Button variant="outline" size="xs"
                                onClick={() => setGrantTenant(t)}>+💰</Button>
                              {t.isActive
                                ? <Button variant="danger" size="xs" loading={actionId === t.id}
                                    onClick={() => suspend(t.id)}>Заморозить</Button>
                                : <Button variant="ghost" size="xs" loading={actionId === t.id}
                                    onClick={() => reinstate(t.id)}>Активировать</Button>
                              }
                            </div>
                          </td>
                        </motion.tr>
                      ))
                  }
                </AnimatePresence>
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs text-text-tertiary">Страница {page} из {totalPages}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Назад</Button>
                <Button variant="outline" size="xs" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Вперёд</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Grant credits dialog */}
      <Dialog.Root open={!!grantTenant} onOpenChange={o => !o && setGrantTenant(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50
            w-full max-w-sm rounded-xl bg-surface-0 border border-border shadow-elevation-3 p-6 space-y-4">
            <Dialog.Title className="text-sm font-semibold text-text-primary">
              Кредиты: {grantTenant?.name}
            </Dialog.Title>
            <p className="text-xs text-text-tertiary">
              Баланс: <span className="text-text-primary font-medium">{grantTenant?.credits.toLocaleString()}</span>
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-text-tertiary mb-1 block">Сумма (отрицательная = списать)</label>
                <input type="number" value={grantAmount} onChange={e => setGrantAmount(e.target.value)}
                  placeholder="500"
                  className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                    focus:outline-none focus:ring-1 focus:ring-brand-500/50 tabular-nums" />
              </div>
              <div>
                <label className="text-xs text-text-tertiary mb-1 block">Описание</label>
                <input value={grantDesc} onChange={e => setGrantDesc(e.target.value)}
                  placeholder="Промо-кредиты"
                  className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                    focus:outline-none focus:ring-1 focus:ring-brand-500/50" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">Отмена</Button>
              </Dialog.Close>
              <Button variant="primary" size="sm" loading={granting} onClick={handleGrant}>
                Применить
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

"use client";

import { useEffect, useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import { motion, AnimatePresence } from "framer-motion";
import { Button, Badge, Input, Card, CardContent } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { adminApi, type AdminUser, type Pagination } from "@/lib/admin-api";
import { relativeTime, cn } from "@/lib/utils";

const ROLE_BADGE: Record<string, React.ReactNode> = {
  owner:  <Badge variant="brand">Owner</Badge>,
  admin:  <Badge variant="info">Admin</Badge>,
  member: <Badge variant="default">Member</Badge>,
  viewer: <Badge variant="outline">Viewer</Badge>,
};

const PLAN_BADGE: Record<string, React.ReactNode> = {
  enterprise: <Badge variant="brand">Enterprise</Badge>,
  pro:        <Badge variant="info">Pro</Badge>,
  starter:    <Badge variant="default">Starter</Badge>,
};

export default function AdminUsersPage() {
  const [users, setUsers]       = useState<AdminUser[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0 });
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [page, setPage]         = useState(1);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [editRole, setEditRole] = useState("");
  const [saving, setSaving]     = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    adminApi.getUsers({ page, search: search || undefined, role: roleFilter || undefined })
      .then(res => { setUsers(res.data); setPagination(res.pagination); })
      .finally(() => setLoading(false));
  }, [page, search, roleFilter]);

  useEffect(() => { load(); }, [load]);

  const handleBan = async (user: AdminUser) => {
    await adminApi.updateUser(user.id, { isActive: !user.isActive });
    load();
  };

  const handleRoleSave = async () => {
    if (!editUser) return;
    setSaving(true);
    try {
      await adminApi.updateUser(editUser.id, { role: editRole as any });
      setEditUser(null);
      load();
    } finally {
      setSaving(false);
    }
  };

  const totalPages = Math.ceil(pagination.total / pagination.limit);

  return (
    <div className="p-6 space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Поиск по email / имени…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="w-full sm:w-64"
        />

        <Select.Root value={roleFilter} onValueChange={(v) => { setRoleFilter(v === "all" ? "" : v); setPage(1); }}>
          <Select.Trigger className="inline-flex items-center h-8 px-3 rounded-md border border-border
            bg-surface-1 text-sm text-text-secondary gap-2 hover:bg-surface-2 cursor-pointer">
            <Select.Value placeholder="Роль" />
            <Select.Icon><ChevronIcon /></Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content className="z-50 rounded-lg border border-border bg-surface-1 shadow-elevation-2 p-1">
              <Select.Viewport>
                {["all", "owner", "admin", "member", "viewer"].map(r => (
                  <Select.Item key={r} value={r}
                    className="flex items-center h-8 px-3 rounded-md text-sm text-text-secondary cursor-pointer
                      hover:bg-surface-2 hover:text-text-primary outline-none">
                    <Select.ItemText>{r === "all" ? "Все роли" : r}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>

        <span className="ml-auto text-xs text-text-tertiary">
          {pagination.total.toLocaleString()} пользователей
        </span>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-1">
                  {["Пользователь", "Тенант / план", "Роль", "Последний вход", "Статус", "Действия"].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs text-text-tertiary font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {loading && users.length === 0 ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="border-b border-border/30">
                        {Array.from({ length: 6 }).map((_, j) => (
                          <td key={j} className="px-4 py-3">
                            <div className="h-3 rounded bg-surface-2 animate-pulse w-24" />
                          </td>
                        ))}
                      </tr>
                    ))
                  ) : users.map(u => (
                    <motion.tr key={u.id} layout
                      className="border-b border-border/30 last:border-0 hover:bg-surface-1 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium text-text-primary text-sm">
                          {u.displayName ?? "—"}
                        </div>
                        <div className="text-xs text-text-tertiary font-mono mt-0.5">{u.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs text-text-primary">{u.tenant.name}</div>
                        <div className="mt-0.5">{PLAN_BADGE[u.tenant.plan] ?? u.tenant.plan}</div>
                      </td>
                      <td className="px-4 py-3">{ROLE_BADGE[u.role] ?? u.role}</td>
                      <td className="px-4 py-3 text-xs text-text-tertiary">
                        {u.lastLoginAt ? relativeTime(u.lastLoginAt) : "никогда"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={u.isActive ? "success" : "danger"} dot>
                          {u.isActive ? "Активен" : "Заблокирован"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <Button variant="ghost" size="xs"
                            onClick={() => { setEditUser(u); setEditRole(u.role); }}>
                            Роль
                          </Button>
                          <Button
                            variant={u.isActive ? "danger" : "ghost"} size="xs"
                            onClick={() => handleBan(u)}>
                            {u.isActive ? "Бан" : "Разбан"}
                          </Button>
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs text-text-tertiary">
                Страница {page} из {totalPages}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="xs" disabled={page <= 1}
                  onClick={() => setPage(p => p - 1)}>Назад</Button>
                <Button variant="outline" size="xs" disabled={page >= totalPages}
                  onClick={() => setPage(p => p + 1)}>Вперёд</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Role edit modal */}
      <Dialog.Root open={!!editUser} onOpenChange={(o) => !o && setEditUser(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm z-50">
            <div className="rounded-2xl border border-border bg-surface-1 shadow-elevation-3 p-6">
              <Dialog.Title className="text-sm font-semibold text-text-primary mb-1">
                Изменить роль
              </Dialog.Title>
              <p className="text-xs text-text-tertiary mb-4">{editUser?.email}</p>

              <Select.Root value={editRole} onValueChange={setEditRole}>
                <Select.Trigger className="w-full inline-flex items-center h-9 px-3 rounded-lg border border-border
                  bg-surface-0 text-sm text-text-primary gap-2 justify-between cursor-pointer hover:bg-surface-1">
                  <Select.Value />
                  <Select.Icon><ChevronIcon /></Select.Icon>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Content className="z-[60] w-full rounded-lg border border-border bg-surface-1 shadow-elevation-2 p-1">
                    <Select.Viewport>
                      {["owner", "admin", "member", "viewer"].map(r => (
                        <Select.Item key={r} value={r}
                          className="flex items-center h-8 px-3 rounded-md text-sm text-text-secondary cursor-pointer
                            hover:bg-surface-2 hover:text-text-primary outline-none">
                          <Select.ItemText>{r}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Viewport>
                  </Select.Content>
                </Select.Portal>
              </Select.Root>

              <div className="rounded-lg bg-warning/10 border border-warning/20 p-3 mt-3">
                <p className="text-xs text-warning">
                  Роли <strong>admin</strong> и <strong>owner</strong> дают доступ к панели администрирования.
                </p>
              </div>

              <div className="flex justify-end gap-2 mt-5">
                <Dialog.Close asChild>
                  <Button variant="ghost" size="sm">Отмена</Button>
                </Dialog.Close>
                <Button variant="primary" size="sm" loading={saving} onClick={handleRoleSave}>
                  Сохранить
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 9l6 6 6-6"/>
    </svg>
  );
}

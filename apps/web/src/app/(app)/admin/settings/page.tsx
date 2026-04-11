"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Button, Badge, Card, CardContent } from "@/components/ui/primitives";
import { adminApi, type AdminSetting } from "@/lib/admin-api";
import { cn } from "@/lib/utils";

const SENSITIVE_KEYS = ["API_KEY", "SECRET", "TOKEN", "PASSWORD", "WEBHOOK"];

function isSensitive(key: string) {
  return SENSITIVE_KEYS.some(s => key.toUpperCase().includes(s));
}

function maskValue(value: string) {
  if (value.length <= 4) return "••••";
  return "••••••••" + value.slice(-4);
}

const SETTING_GROUPS: Record<string, string[]> = {
  "Прокси":             ["AI_PROXY_URL"],
  "Лимиты генерации": ["MAX_CONCURRENT_JOBS", "MAX_SCENES_PER_VIDEO", "MAX_VIDEOS_PER_TENANT_DAY", "JOB_TIMEOUT_SECONDS"],
  "Кредиты & Биллинг": ["CREDIT_COST_PER_SEC_AVATAR", "CREDIT_COST_PER_SEC_CLIP", "CREDIT_COST_PER_IMAGE", "STARTER_CREDITS", "PRO_CREDITS"],
  "Провайдеры AI":     ["IMAGE_GEN_PROVIDER", "HEYGEN_DEFAULT_VOICE", "KLING_DEFAULT_ASPECT", "GPT_MODEL"],
  "Промпты":           ["GPT_SYSTEM_PROMPT", "DEFAULT_SCRIPT_TEMPLATE", "AVATAR_STYLE_PROMPT"],
  "Системные":         [],
};

export default function AdminSettingsPage() {
  const [settings, setSettings]   = useState<AdminSetting[]>([]);
  const [loading, setLoading]     = useState(true);
  const [editing, setEditing]     = useState<string | null>(null);
  const [editVal, setEditVal]     = useState("");
  const [saving, setSaving]       = useState(false);
  const [showMasked, setShowMasked] = useState<Set<string>>(new Set());
  const [addKey, setAddKey]       = useState("");
  const [addVal, setAddVal]       = useState("");
  const [addDesc, setAddDesc]     = useState("");
  const [addOpen, setAddOpen]     = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    adminApi.getSettings()
      .then(setSettings)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (s: AdminSetting) => {
    setEditing(s.key);
    setEditVal(s.value);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const saveEdit = async (key: string) => {
    setSaving(true);
    try {
      await adminApi.upsertSetting(key, editVal);
      setSettings(prev => prev.map(s => s.key === key ? { ...s, value: editVal } : s));
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    if (!addKey.trim()) return;
    setSaving(true);
    try {
      await adminApi.upsertSetting(addKey.trim().toUpperCase(), addVal, addDesc);
      setAddKey(""); setAddVal(""); setAddDesc("");
      setAddOpen(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (key: string) => {
    await adminApi.deleteSetting(key);
    setSettings(prev => prev.filter(s => s.key !== key));
    setDeleteTarget(null);
  };

  const toggleMask = (key: string) => {
    setShowMasked(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // Group settings
  const known = new Set(Object.values(SETTING_GROUPS).flat());
  const groups: Record<string, AdminSetting[]> = {};
  Object.keys(SETTING_GROUPS).forEach(g => {
    groups[g] = settings.filter(s => SETTING_GROUPS[g].includes(s.key));
  });
  groups["Системные"] = settings.filter(s => !known.has(s.key));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-tertiary">{settings.length} настроек</p>
        <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
          + Добавить настройку
        </Button>
      </div>

      {loading
        ? Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-5 space-y-3">
                <div className="h-4 w-32 rounded bg-surface-2 animate-pulse" />
                {Array.from({ length: 3 }).map((_, j) => (
                  <div key={j} className="h-10 rounded bg-surface-1 animate-pulse" />
                ))}
              </CardContent>
            </Card>
          ))
        : Object.entries(groups).map(([group, items]) => items.length === 0 ? null : (
            <Card key={group}>
              <CardContent className="p-0">
                <div className="px-5 py-3 border-b border-border bg-surface-1">
                  <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">{group}</p>
                </div>
                <div className="divide-y divide-border/30">
                  {items.map(s => {
                    const sens = isSensitive(s.key);
                    const masked = sens && !showMasked.has(s.key);
                    const displayVal = masked ? maskValue(s.value) : s.value;

                    return (
                      <div key={s.key} className="px-5 py-3 flex items-start gap-4 group hover:bg-surface-1 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <code className="text-xs font-mono text-brand-300">{s.key}</code>
                            {sens && (
                              <Badge variant="warning" className="text-[9px] py-0">sensitive</Badge>
                            )}
                          </div>
                          {s.description && (
                            <p className="text-[11px] text-text-tertiary mb-1">{s.description}</p>
                          )}

                          {editing === s.key ? (
                            <div className="flex items-center gap-2 mt-1">
                              <input
                                ref={inputRef}
                                value={editVal}
                                onChange={e => setEditVal(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") saveEdit(s.key); if (e.key === "Escape") setEditing(null); }}
                                className="flex-1 h-7 px-2.5 text-xs rounded-md bg-surface-2 border border-brand-500/50
                                  text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                              />
                              <Button variant="primary" size="xs" loading={saving} onClick={() => saveEdit(s.key)}>Сохранить</Button>
                              <Button variant="ghost"   size="xs" onClick={() => setEditing(null)}>Отмена</Button>
                            </div>
                          ) : (
                            <p className={cn("text-xs tabular-nums", masked ? "text-text-tertiary" : "text-text-primary font-mono break-all")}>
                              {displayVal}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          {sens && (
                            <Button variant="ghost" size="xs" onClick={() => toggleMask(s.key)}>
                              {masked ? "Показать" : "Скрыть"}
                            </Button>
                          )}
                          <Button variant="ghost" size="xs" onClick={() => startEdit(s)}>Изменить</Button>
                          <Button variant="ghost" size="xs" className="text-danger/70 hover:text-danger"
                            onClick={() => setDeleteTarget(s.key)}>✕</Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))
      }

      {/* Add setting dialog */}
      <AlertDialog.Root open={addOpen} onOpenChange={setAddOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50
            w-full max-w-md rounded-xl bg-surface-0 border border-border shadow-elevation-3 p-6 space-y-4">
            <AlertDialog.Title className="text-sm font-semibold text-text-primary">Новая настройка</AlertDialog.Title>
            <div className="space-y-3">
              <Field label="Ключ (KEY_NAME)">
                <input value={addKey} onChange={e => setAddKey(e.target.value.toUpperCase())}
                  placeholder="MAX_CONCURRENT_JOBS"
                  className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                    focus:outline-none focus:ring-1 focus:ring-brand-500/50 font-mono" />
              </Field>
              <Field label="Значение">
                <input value={addVal} onChange={e => setAddVal(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                    focus:outline-none focus:ring-1 focus:ring-brand-500/50" />
              </Field>
              <Field label="Описание (опционально)">
                <input value={addDesc} onChange={e => setAddDesc(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                    focus:outline-none focus:ring-1 focus:ring-brand-500/50" />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button variant="ghost" size="sm">Отмена</Button>
              </AlertDialog.Cancel>
              <Button variant="primary" size="sm" loading={saving} onClick={handleAdd}>Создать</Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {/* Delete confirm */}
      <AlertDialog.Root open={!!deleteTarget} onOpenChange={o => !o && setDeleteTarget(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50
            w-full max-w-sm rounded-xl bg-surface-0 border border-border shadow-elevation-3 p-6 space-y-4">
            <AlertDialog.Title className="text-sm font-semibold text-text-primary">Удалить настройку?</AlertDialog.Title>
            <AlertDialog.Description className="text-xs text-text-secondary">
              Ключ <code className="font-mono text-brand-300">{deleteTarget}</code> будет удалён безвозвратно.
            </AlertDialog.Description>
            <div className="flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button variant="ghost" size="sm">Отмена</Button>
              </AlertDialog.Cancel>
              <Button variant="danger" size="sm" onClick={() => deleteTarget && handleDelete(deleteTarget)}>Удалить</Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-text-tertiary mb-1 block">{label}</label>
      {children}
    </div>
  );
}

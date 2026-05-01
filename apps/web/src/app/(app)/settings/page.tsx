"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { TopBar } from "@/components/layout/AppShell";
import { Button, Badge, Card, CardContent, LoadingSpinner } from "@/components/ui/primitives";
import { socialAccountsApi, type SocialAccount, getAccessToken } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Platform metadata ─────────────────────────────────────────────────────────

const PLATFORMS = [
  { value: "tiktok",         label: "TikTok",         color: "bg-[#ff0050]/10 text-[#ff0050]" },
  { value: "instagram",      label: "Instagram",      color: "bg-[#e1306c]/10 text-[#e1306c]" },
  { value: "youtube_shorts", label: "YouTube Shorts",  color: "bg-[#ff0000]/10 text-[#ff0000]" },
] as const;

function platformLabel(value: string) {
  return PLATFORMS.find(p => p.value === value)?.label ?? value;
}

function platformColor(value: string) {
  return PLATFORMS.find(p => p.value === value)?.color ?? "bg-surface-2 text-text-secondary";
}

// ── Page Content ──────────────────────────────────────────────────────────────

function SettingsContent() {
  const searchParams = useSearchParams();
  const [accounts, setAccounts]       = useState<SocialAccount[]>([]);
  const [loading, setLoading]         = useState(true);
  const [addOpen, setAddOpen]         = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SocialAccount | null>(null);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [status, setStatus]           = useState<string | null>(null);

  // Form state (fallback manual)
  const [showManual, setShowManual]   = useState(false);
  const [platform, setPlatform]       = useState("tiktok");
  const [accountName, setAccountName] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [igUserId, setIgUserId]       = useState("");
  const [proxyUrl, setProxyUrl]       = useState("");

  const load = useCallback(() => {
    setLoading(true);
    socialAccountsApi.list()
      .then(setAccounts)
      .catch(() => setError("Не удалось загрузить аккаунты"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const success = searchParams.get("success");
    const err = searchParams.get("error");
    const msg = searchParams.get("message");
    if (success) setStatus("Аккаунт успешно подключён");
    if (err) setError(msg || "Ошибка при подключении аккаунта");
  }, [searchParams]);

  const resetForm = () => {
    setPlatform("tiktok");
    setAccountName("");
    setAccessToken("");
    setRefreshToken("");
    setIgUserId("");
    setProxyUrl("");
    setError(null);
    setShowManual(false);
  };

  const handleOAuth = (p: string) => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
    // Construct the authorize URL with token (carried in state eventually)
    window.location.href = `${apiBase}/api/v1/social/${p}/authorize?token=${getAccessToken()}`;
  };

  const handleAddManual = async () => {
    if (!accountName.trim() || !accessToken.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await socialAccountsApi.create({
        platform,
        accountName: accountName.trim(),
        accessToken: accessToken.trim(),
        refreshToken: refreshToken.trim() || undefined,
        igUserId: platform === "instagram" && igUserId.trim() ? igUserId.trim() : undefined,
        proxyUrl: proxyUrl.trim() || undefined,
      });
      resetForm();
      setAddOpen(false);
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Ошибка при подключении аккаунта");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await socialAccountsApi.delete(deleteTarget.id);
      setAccounts(prev => prev.filter(a => a.id !== deleteTarget.id));
    } catch {
      setError("Не удалось отключить аккаунт");
    }
    setDeleteTarget(null);
  };

  const activeAccounts = accounts.filter(a => a.isActive);
  const inactiveAccounts = accounts.filter(a => !a.isActive);

  return (
    <>
      <TopBar
        title="Настройки"
        actions={
          <Button variant="primary" size="sm" onClick={() => { resetForm(); setAddOpen(true); }}>
            + Подключить аккаунт
          </Button>
        }
      />

      <div className="p-6 space-y-6 max-w-3xl">
        {status && (
          <div className="bg-green-50 text-green-700 p-3 rounded-lg text-sm mb-4">
            {status}
          </div>
        )}

        {error && (
          <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm mb-4">
            {error}
          </div>
        )}

        {/* ── Social accounts ────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-text-primary mb-1">Социальные сети</h2>
          <p className="text-xs text-text-tertiary mb-4">
            Подключённые аккаунты для автоматической публикации видео
          </p>

          {loading ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner size={24} />
            </div>
          ) : activeAccounts.length === 0 && inactiveAccounts.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <p className="text-sm text-text-secondary mb-3">Нет подключённых аккаунтов</p>
                <Button variant="primary" size="sm" onClick={() => { resetForm(); setAddOpen(true); }}>
                  Подключить первый аккаунт
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {activeAccounts.map(account => (
                <Card key={account.id}>
                  <CardContent className="px-5 py-3 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium text-text-primary truncate">
                          {account.accountName}
                        </span>
                        <Badge className={cn("text-[10px] py-0", platformColor(account.platform))}>
                          {platformLabel(account.platform)}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-text-tertiary flex-wrap">
                        <span>Публикаций: {account._count?.publishJobs ?? 0}</span>
                        {account.proxyUrl && (
                          <span title={account.proxyUrl}>Прокси: ✓</span>
                        )}
                        {!account.proxyUrl && (
                          <span className="text-warning">Без прокси</span>
                        )}
                        {account.expiresAt && (
                          <span>
                            Токен истекает: {new Date(account.expiresAt).toLocaleDateString("ru-RU")}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-danger/70 hover:text-danger shrink-0"
                      onClick={() => setDeleteTarget(account)}
                    >
                      Отключить
                    </Button>
                  </CardContent>
                </Card>
              ))}

              {inactiveAccounts.length > 0 && (
                <>
                  <p className="text-xs text-text-tertiary pt-2">Отключённые</p>
                  {inactiveAccounts.map(account => (
                    <Card key={account.id} className="opacity-50">
                      <CardContent className="px-5 py-3 flex items-center gap-4">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-text-secondary truncate">
                            {account.accountName}
                          </span>
                          <Badge className={cn("ml-2 text-[10px] py-0", platformColor(account.platform))}>
                            {platformLabel(account.platform)}
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </>
              )}
            </div>
          )}
        </section>
      </div>

      {/* ── Add account dialog ────────────────────────────────────── */}
      <AlertDialog.Root open={addOpen} onOpenChange={o => { if (!o) setAddOpen(false); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50
            w-full max-w-md rounded-xl bg-surface-0 border border-border shadow-elevation-3 p-6 space-y-4">
            <AlertDialog.Title className="text-sm font-semibold text-text-primary">
              Подключить аккаунт
            </AlertDialog.Title>

            <div className="space-y-4">
              <div className="grid gap-3">
                <button
                  onClick={() => handleOAuth("tiktok")}
                  className="flex items-center gap-3 w-full p-3 rounded-xl border border-border hover:bg-surface-2 transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-lg bg-[#ff0050] flex items-center justify-center text-white shrink-0">
                    T
                  </div>
                  <div>
                    <div className="text-sm font-semibold">TikTok</div>
                    <div className="text-[11px] text-text-tertiary">Авторизация через TikTok OAuth 2.0</div>
                  </div>
                </button>

                <button
                  onClick={() => handleOAuth("instagram")}
                  className="flex items-center gap-3 w-full p-3 rounded-xl border border-border hover:bg-surface-2 transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-lg bg-[#e1306c] flex items-center justify-center text-white shrink-0">
                    I
                  </div>
                  <div>
                    <div className="text-sm font-semibold">Instagram</div>
                    <div className="text-[11px] text-text-tertiary">Через Facebook Graph API</div>
                  </div>
                </button>

                <button
                  onClick={() => handleOAuth("youtube")}
                  className="flex items-center gap-3 w-full p-3 rounded-xl border border-border hover:bg-surface-2 transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-lg bg-[#ff0000] flex items-center justify-center text-white shrink-0">
                    Y
                  </div>
                  <div>
                    <div className="text-sm font-semibold">YouTube Shorts</div>
                    <div className="text-[11px] text-text-tertiary">Через Google OAuth 2.0</div>
                  </div>
                </button>
              </div>

              {!showManual && (
                <button
                  onClick={() => setShowManual(true)}
                  className="text-[11px] text-text-tertiary hover:text-brand-400 w-full text-center"
                >
                  Ввести токен вручную (для продвинутых)
                </button>
              )}

              {showManual && (
                <div className="pt-4 border-t border-dashed space-y-3 animate-in fade-in slide-in-from-top-2">
                  <Field label="Платформа">
                    <select
                      value={platform}
                      onChange={e => setPlatform(e.target.value)}
                      className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                        focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                    >
                      {PLATFORMS.map(p => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Имя аккаунта">
                    <input
                      value={accountName}
                      onChange={e => setAccountName(e.target.value)}
                      placeholder="@username"
                      className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                        focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                    />
                  </Field>

                  <Field label="Access Token">
                    <input
                      type="password"
                      value={accessToken}
                      onChange={e => setAccessToken(e.target.value)}
                      placeholder="Вставьте токен доступа"
                      className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                        focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                    />
                  </Field>

                  <Field label="Refresh Token (опционально)">
                    <input
                      type="password"
                      value={refreshToken}
                      onChange={e => setRefreshToken(e.target.value)}
                      placeholder="Для автоматического обновления токена"
                      className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                        focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                    />
                  </Field>

                  {platform === "instagram" && (
                    <Field label="Instagram Business Account ID">
                      <input
                        value={igUserId}
                        onChange={e => setIgUserId(e.target.value)}
                        placeholder="Числовой ID бизнес-аккаунта"
                        className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                          focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                      />
                    </Field>
                  )}

                  <Field label="Прокси (рекомендуется)">
                    <input
                      value={proxyUrl}
                      onChange={e => setProxyUrl(e.target.value)}
                      placeholder="socks5://user:pass@ip:port или http://ip:port"
                      className="w-full h-8 px-2.5 text-xs rounded-md bg-surface-2 border border-border text-text-primary
                        focus:outline-none focus:ring-1 focus:ring-brand-500/50 font-mono"
                    />
                  </Field>

                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full"
                    loading={saving}
                    disabled={!accountName.trim() || !accessToken.trim()}
                    onClick={handleAddManual}
                  >
                    Подключить вручную
                  </Button>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <AlertDialog.Cancel asChild>
                <Button variant="ghost" size="sm">Отмена</Button>
              </AlertDialog.Cancel>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {/* ── Delete confirm dialog ─────────────────────────────────── */}
      <AlertDialog.Root open={!!deleteTarget} onOpenChange={o => { if (!o) setDeleteTarget(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50
            w-full max-w-sm rounded-xl bg-surface-0 border border-border shadow-elevation-3 p-6 space-y-4">
            <AlertDialog.Title className="text-sm font-semibold text-text-primary">
              Отключить аккаунт?
            </AlertDialog.Title>
            <AlertDialog.Description className="text-xs text-text-secondary">
              Аккаунт <span className="font-medium text-text-primary">{deleteTarget?.accountName}</span>{" "}
              ({platformLabel(deleteTarget?.platform ?? "")}) будет отключён. Ранее опубликованные видео останутся.
            </AlertDialog.Description>
            <div className="flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button variant="ghost" size="sm">Отмена</Button>
              </AlertDialog.Cancel>
              <Button variant="danger" size="sm" onClick={handleDelete}>
                Отключить
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
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

// ── Main Page Component ───────────────────────────────────────────────────────

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-20"><LoadingSpinner size={32} /></div>}>
      <SettingsContent />
    </Suspense>
  );
}

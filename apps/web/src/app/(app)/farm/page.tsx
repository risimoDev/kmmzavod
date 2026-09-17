"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  LoadingSpinner,
  Badge,
  Card,
  CardContent,
  Input,
  Textarea,
  EmptyState,
} from "@/components/ui/primitives";
import { relativeTime, cn, accountUrl } from "@/lib/utils";
import {
  accountFarmApi,
  getAccessToken,
  type AccountGroup,
  type Proxy,
  type FarmSocialAccount,
  type FarmMetrics,
  type PublishDiagnostics,
  type FarmDevice,
  type DeviceIpCheck,
  type BoardHealthInfo,
  type WbWarmupResponse,
} from "@/lib/api";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "devices", label: "Стойка плат (20 шт)" },
  { value: "groups", label: "Groups" },
  { value: "proxies", label: "Proxies" },
  { value: "accounts", label: "Accounts" },
];

export default function FarmPage() {
  return (
    <Suspense
      fallback={
        <>
          <TopBar title="Account Farm" />
          <main className="flex-1 flex items-center justify-center">
            <LoadingSpinner size={32} />
          </main>
        </>
      }
    >
      <FarmContent />
    </Suspense>
  );
}

function FarmContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") ?? "overview";

  useEffect(() => {
    if (!getAccessToken()) router.replace("/login");
  }, [router]);

  const setTab = (t: string) => router.push(`/farm?tab=${t}`);

  return (
    <>
      <TopBar
        title="Account Farm"
        subtitle="Manage groups, proxies and social accounts at scale"
      />
      <main className="flex-1 p-6 space-y-5 animate-slide-up">
        <div className="flex gap-2">
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                tab === t.value
                  ? "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30"
                  : "bg-surface-2 text-text-secondary hover:text-text-primary hover:bg-surface-3"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "overview" && <OverviewTab />}
        {tab === "devices" && <DevicesTab />}
        {tab === "groups" && <GroupsTab />}
        {tab === "proxies" && <ProxiesTab />}
        {tab === "accounts" && <AccountsTab />}
      </main>
    </>
  );
}

// ── Overview / Metrics ────────────────────────────────────────────────────────

const BLOCKER_HINTS: Record<string, string> = {
  "Нет сессии — добавьте sessionid/cookie":
    "TikTok/Instagram импортируйте форматом с cookies (из sid_guard извлечётся sessionid), либо добавьте sessionid через правку аккаунта.",
  "Не прогрет (группа требует warmup)":
    "Отключите «Требовать warmup» у группы, либо дождитесь прогрева (cold→warming).",
  "Обнаружен shadow-ban": "Аккаунт под shadow-ban — дайте ему отдохнуть или замените.",
  "Аккаунт на паузе": "Активируйте аккаунт.",
};

/** One-glance "why can't I publish" panel with concrete fixes. */
function PublishDiagnosticsCard({ diag, onRefresh }: { diag: PublishDiagnostics; onRefresh: () => void }) {
  const ok = diag.canPublishNow;
  return (
    <Card className={cn("border", ok ? "border-success/40" : "border-warning/50")}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={cn("w-2.5 h-2.5 rounded-full", ok ? "bg-success" : "bg-warning animate-pulse")} />
            <h3 className="text-sm font-semibold text-text-primary">
              {ok ? "Публикация готова к работе" : "Публикация не работает — вот почему"}
            </h3>
          </div>
          <Button variant="ghost" size="xs" onClick={onRefresh}>Обновить</Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {diag.checks.map((c) => (
            <div key={c.id} className="flex items-start gap-2 text-xs">
              <span className={cn("mt-0.5 shrink-0", c.ok ? "text-success" : "text-danger")}>{c.ok ? "✓" : "✕"}</span>
              <span className="min-w-0">
                <span className="text-text-primary">{c.label}</span>
                {!c.ok && c.fix && <span className="block text-warning">{c.fix}</span>}
              </span>
            </div>
          ))}
        </div>

        {Object.keys(diag.accounts.blockers).length > 0 && (
          <div className="border-t border-border pt-2 space-y-1">
            <p className="text-2xs font-semibold text-text-tertiary uppercase">Почему аккаунты не публикуют</p>
            {Object.entries(diag.accounts.blockers).map(([blocker, count]) => (
              <div key={blocker} className="text-xs">
                <span className="text-danger">{count}×</span>{" "}
                <span className="text-text-secondary">{blocker}</span>
                {BLOCKER_HINTS[blocker] && (
                  <span className="block text-2xs text-text-tertiary ml-4">→ {BLOCKER_HINTS[blocker]}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {diag.publisher.checkedAt && (
          <p className="text-2xs text-text-tertiary">
            Publisher {diag.publisher.url ?? ""} · проверен {relativeTime(diag.publisher.checkedAt)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function OverviewTab() {
  const [metrics, setMetrics] = useState<FarmMetrics | null>(null);
  const [diag, setDiag] = useState<PublishDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [m, d] = await Promise.all([
        accountFarmApi.metrics(),
        accountFarmApi.diagnostics().catch(() => null),
      ]);
      setMetrics(m);
      setDiag(d);
    } catch (e: any) {
      setError(e.message ?? "Failed to load metrics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <CenterSpinner />;
  if (error) return <ErrorRetry error={error} onRetry={load} />;
  if (!metrics) return null;

  const { accounts, proxies } = metrics;

  return (
    <div className="space-y-5">
      {diag && <PublishDiagnosticsCard diag={diag} onRefresh={load} />}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard label="Total accounts" value={accounts.total} />
        <StatCard label="Active" value={accounts.active} tone="success" />
        <StatCard label="Low health" value={accounts.lowHealth} tone={accounts.lowHealth > 0 ? "warning" : "default"} />
        <StatCard label="Shadow-banned" value={accounts.shadowBanned} tone={accounts.shadowBanned > 0 ? "danger" : "default"} />
        <StatCard label="Posts today" value={accounts.postsToday} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card>
          <CardContent className="space-y-3">
            <h3 className="text-sm font-semibold text-text-primary">Health by platform</h3>
            {accounts.healthByPlatform.length === 0 ? (
              <p className="text-xs text-text-tertiary">No accounts yet</p>
            ) : (
              accounts.healthByPlatform.map((p) => (
                <div key={p.platform} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-text-secondary capitalize">{p.platform} ({p.count})</span>
                    <span className="text-text-tertiary">{Math.round(p.avgHealth)}/100</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        p.avgHealth >= 70 ? "bg-success" : p.avgHealth >= 40 ? "bg-warning" : "bg-danger"
                      )}
                      style={{ width: `${Math.max(0, Math.min(100, p.avgHealth))}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3">
            <h3 className="text-sm font-semibold text-text-primary">Proxies</h3>
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Total" value={proxies.total} compact />
              <StatCard label="Active" value={proxies.active} tone="success" compact />
              <StatCard label="Failed" value={proxies.failed} tone={proxies.failed > 0 ? "danger" : "default"} compact />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone = "default", compact }: { label: string; value: number; tone?: "default" | "success" | "warning" | "danger"; compact?: boolean }) {
  const toneClass = {
    default: "text-text-primary",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  }[tone];
  return (
    <Card>
      <CardContent className={compact ? "p-3" : undefined}>
        <p className={cn("font-semibold", compact ? "text-xl" : "text-2xl", toneClass)}>{value}</p>
        <p className="text-xs text-text-tertiary mt-0.5">{label}</p>
      </CardContent>
    </Card>
  );
}

// ── Groups ────────────────────────────────────────────────────────────────────

function GroupsTab() {
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [maxPostsPerDay, setMaxPostsPerDay] = useState(3);
  const [staggerMinutes, setStaggerMinutes] = useState(120);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGroups(await accountFarmApi.listGroups());
    } catch (e: any) {
      setError(e.message ?? "Failed to load groups");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!name || !niche) return;
    setSaving(true);
    try {
      await accountFarmApi.createGroup({ name, niche, timezone, maxPostsPerDay, staggerMinutes });
      setShowForm(false);
      setName(""); setNiche("");
      load();
    } catch (e: any) {
      alert(e.message ?? "Failed to create group");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this group? Accounts will be unassigned.")) return;
    try {
      await accountFarmApi.deleteGroup(id);
      load();
    } catch (e: any) {
      alert(e.message ?? "Failed to delete");
    }
  };

  if (loading) return <CenterSpinner />;
  if (error) return <ErrorRetry error={error} onRetry={load} />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>New Group</Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState title="No account groups" description="Create a group to organize accounts by niche, timezone and posting limits" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map((g) => (
            <Card key={g.id}>
              <CardContent className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{g.name}</p>
                    <p className="text-xs text-text-tertiary">{g.niche}</p>
                  </div>
                  {g.isActive ? <Badge variant="success">active</Badge> : <Badge variant="default">paused</Badge>}
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-text-tertiary">
                  <span>{g._count?.accounts ?? 0} accounts</span>
                  <span>·</span>
                  <span>{g.timezone}</span>
                  <span>·</span>
                  <span>{g.maxPostsPerDay}/day</span>
                  <span>·</span>
                  <span>{g.staggerMinutes}min stagger</span>
                </div>
                <div className="pt-1">
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(g.id)}>Delete</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showForm && (
        <Modal title="New Account Group" onClose={() => setShowForm(false)}>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="US Fitness Pool" />
          <Input label="Niche" value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="fitness" />
          <div className="grid grid-cols-3 gap-3">
            <Input label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC" />
            <Input label="Max posts/day" type="number" min={1} max={100} value={maxPostsPerDay} onChange={(e) => setMaxPostsPerDay(Number(e.target.value))} />
            <Input label="Stagger (min)" type="number" min={1} max={1440} value={staggerMinutes} onChange={(e) => setStaggerMinutes(Number(e.target.value))} />
          </div>
          <ModalActions onCancel={() => setShowForm(false)} onConfirm={handleCreate} loading={saving} disabled={!name || !niche} confirmLabel="Create" />
        </Modal>
      )}
    </div>
  );
}

// ── Proxies ───────────────────────────────────────────────────────────────────

function ProxiesTab() {
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [raw, setRaw] = useState("");
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProxies(await accountFarmApi.listProxies());
    } catch (e: any) {
      setError(e.message ?? "Failed to load proxies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleImport = async () => {
    // Parse lines: host:port:type[:country[:username:password]]
    const parsed = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [host, port, type = "http", country, username, password] = line.split(":");
        return {
          host,
          port: Number(port),
          type: (["http", "https", "socks5", "residential", "mobile"].includes(type) ? type : "http") as
            "http" | "https" | "socks5" | "residential" | "mobile",
          country: country || undefined,
          username: username || undefined,
          password: password || undefined,
        };
      })
      .filter((p) => p.host && p.port);

    if (parsed.length === 0) { alert("No valid proxies parsed"); return; }
    setImporting(true);
    try {
      const res = await accountFarmApi.bulkImportProxies(parsed);
      alert(`Imported ${res.imported} proxies`);
      setShowImport(false);
      setRaw("");
      load();
    } catch (e: any) {
      alert(e.message ?? "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const [assigning, setAssigning] = useState(false);

  const handleHealthCheck = async (id: string) => {
    setCheckingId(id);
    try {
      const res = await accountFarmApi.healthCheckProxy(id);
      if (!res.ok) alert("Proxy is unreachable");
      load();
    } catch (e: any) {
      alert(e.message ?? "Health check failed");
    } finally {
      setCheckingId(null);
    }
  };

  const handleAutoAssign = async () => {
    setAssigning(true);
    try {
      const res = await accountFarmApi.autoAssignProxies();
      alert(
        `Назначено прокси: ${res.assigned}.` +
        (res.remaining ? ` Без прокси осталось: ${res.remaining}.` : "") +
        (res.note ? `\n${res.note}` : "")
      );
      load();
    } catch (e: any) {
      alert(e.message ?? "Auto-assign failed");
    } finally {
      setAssigning(false);
    }
  };

  if (loading) return <CenterSpinner />;
  if (error) return <ErrorRetry error={error} onRetry={load} />;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-xs text-text-tertiary">
          Правило: 1 прокси = максимум 1 аккаунт на платформу (TikTok+Instagram могут делить один IP)
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" loading={assigning} onClick={handleAutoAssign}>
            Распределить прокси
          </Button>
          <Button variant="primary" size="sm" onClick={() => setShowImport(true)}>Bulk Import</Button>
        </div>
      </div>

      {proxies.length === 0 ? (
        <EmptyState title="No proxies" description="Import proxies to assign them to social accounts automatically" />
      ) : (
        <div className="space-y-2">
          {proxies.map((p) => (
            <Card key={p.id}>
              <CardContent className="px-5 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary truncate">{p.host}:{p.port}</span>
                    <Badge variant="outline" className="text-2xs">{p.type}</Badge>
                    {p.isActive ? <Badge variant="success" className="text-2xs">active</Badge> : <Badge variant="danger" className="text-2xs">down</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-text-tertiary mt-0.5">
                    {p.country && <span>{p.country}</span>}
                    <span>{p.assignedAccounts}/{p.maxAccounts} accounts</span>
                    {p.failCount > 0 && <span className="text-warning">{p.failCount} fails</span>}
                    {p.healthCheckAt && <span>checked {relativeTime(p.healthCheckAt)}</span>}
                  </div>
                </div>
                <Button variant="outline" size="sm" loading={checkingId === p.id} onClick={() => handleHealthCheck(p.id)}>
                  Check
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showImport && (
        <Modal title="Bulk Import Proxies" onClose={() => setShowImport(false)}>
          <p className="text-xs text-text-tertiary">
            One per line: <code>host:port:type:country:username:password</code><br />
            type = http | https | socks5 | residential | mobile. Only host:port required.
          </p>
          <Textarea
            label="Proxies"
            rows={8}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={"1.2.3.4:8080:http:US:user:pass\n5.6.7.8:1080:socks5"}
          />
          <ModalActions onCancel={() => setShowImport(false)} onConfirm={handleImport} loading={importing} disabled={!raw.trim()} confirmLabel="Import" />
        </Modal>
      )}
    </div>
  );
}

// ── Accounts ──────────────────────────────────────────────────────────────────

// ── Import formats ────────────────────────────────────────────────────────────
// Each parser turns one raw line into the credential fields the bulk-import API
// expects. accountName defaults to the login when the format has no separate name.

type ParsedCreds = Record<string, string | undefined> & { accountName?: string };
type ImportFormat = {
  id: string;
  label: string;
  template: string;
  placeholder: string;
  parse: (line: string) => ParsedCreds | null;
};

/** Split on the FIRST colon only (passwords/tokens may contain none, but be safe). */
function splitFirst(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

function getImportFormats(
  platform: string,
  method: "official" | "private" | "device",
): ImportFormat[] {
  if (method === "official") {
    return [{
      id: "token",
      label: "accountName:accessToken[:refreshToken]",
      template: "accountName:accessToken:refreshToken",
      placeholder: "my_account:ACCESS_TOKEN:REFRESH_TOKEN",
      parse: (line) => {
        const [accountName, accessToken, refreshToken] = line.split(":");
        if (!accountName || !accessToken) return null;
        return { accountName, accessToken, refreshToken: refreshToken || undefined };
      },
    }];
  }
  if (method === "device") {
    return [{
      id: "name_device_id",
      label: "accountName:deviceId (серийный номер в ADB, см. GET /devices device-agent'а)",
      template: "accountName:deviceId",
      placeholder: "my_account:8f3a1c92",
      parse: (line) => {
        const [accountName, deviceId] = splitFirst(line, ":");
        if (!accountName || !deviceId) return null;
        return { accountName, deviceId };
      },
    }];
  }
  if (platform === "instagram") {
    return [
      {
        id: "login_pass_tech_cookie",
        label: "Login:Pass|Tech_data|Cookie|",
        template: "Login:Pass|Tech_data|Cookie|",
        placeholder: "ivan_p:qwerty123|Android device...|sessionid=123%3Aabc; csrftoken=...|",
        parse: (line) => {
          const segs = line.split("|");
          const [login, password] = splitFirst(segs[0] ?? "", ":");
          if (!login || !password) return null;
          return {
            accountName: login, username: login, password,
            techData: segs[1]?.trim() || undefined,
            cookie: segs[2]?.trim() || undefined,
          };
        },
      },
      {
        id: "name_user_pass",
        label: "accountName:username:password",
        template: "accountName:username:password",
        placeholder: "my_account:my_login:my_password",
        parse: (line) => {
          const parts = line.split(":");
          if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return null;
          return { accountName: parts[0], username: parts[1], password: parts.slice(2).join(":") };
        },
      },
      {
        id: "login_pass",
        label: "login:password",
        template: "login:password",
        placeholder: "my_login:my_password",
        parse: (line) => {
          const [login, password] = splitFirst(line, ":");
          if (!login || !password) return null;
          return { accountName: login, username: login, password };
        },
      },
    ];
  }
  // TikTok
  return [
    {
      id: "user_pass_mail_cookies",
      label: "login:password:mail:mailpass + cookies JSON (готов к постингу)",
      template: "login:password:mail:mailpassword [{cookies JSON из браузера}]",
      placeholder: 'crispgecko140:wK2KE&tQ08:box@mail.com:GIZh8k6tYb [{"name":"sid_guard","value":"6d55...%7C..."},{"name":"msToken","value":"..."}]',
      parse: (line) => {
        // Creds section ends where the JSON cookie array starts.
        const br = line.indexOf("[");
        const credPart = (br >= 0 ? line.slice(0, br) : line).trim();
        const cookie = br >= 0 ? line.slice(br).trim() : undefined;
        const parts = credPart.split(":");
        if (parts.length < 2 || !parts[0] || !parts[1]) return null;
        return {
          accountName: parts[0], username: parts[0], password: parts[1],
          email: parts[2]?.trim() || undefined,
          emailPassword: parts[3]?.trim() || undefined,
          cookie,  // backend parses JSON, derives sessionid from sid_guard
        };
      },
    },
    {
      id: "user_pass_2fa",
      label: "username:password:2FA",
      template: "username:password:2FA_token",
      placeholder: "my_login:my_password:JBSWY3DPEHPK3PXP",
      parse: (line) => {
        const parts = line.split(":");
        if (parts.length < 2 || !parts[0] || !parts[1]) return null;
        return {
          accountName: parts[0], username: parts[0], password: parts[1],
          twoFactorSeed: parts[2]?.trim() || undefined,
        };
      },
    },
    {
      id: "user_pass_mail",
      label: "login:password:mail:mailpassword",
      template: "login:password:mail:mailpassword",
      placeholder: "my_login:my_password:box@mail.com:mailpass",
      parse: (line) => {
        const parts = line.split(":");
        if (parts.length < 2 || !parts[0] || !parts[1]) return null;
        return {
          accountName: parts[0], username: parts[0], password: parts[1],
          email: parts[2]?.trim() || undefined,
          emailPassword: parts[3]?.trim() || undefined,
        };
      },
    },
    {
      id: "name_sessionid",
      label: "accountName:sessionId (готов к постингу)",
      template: "accountName:sessionId",
      placeholder: "my_account:SESSIONID_COOKIE",
      parse: (line) => {
        const [accountName, sessionId] = splitFirst(line, ":");
        if (!accountName || !sessionId) return null;
        return { accountName, sessionId };
      },
    },
  ];
}

/** TikTok formats that carry a posting session (sessionid or cookies). */
const TIKTOK_POST_READY = new Set(["user_pass_mail_cookies", "name_sessionid"]);

function AccountsTab() {
  const [data, setData] = useState<{ accounts: FarmSocialAccount[]; total: number } | null>(null);
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [raw, setRaw] = useState("");
  const [platform, setPlatform] = useState<"tiktok" | "instagram" | "youtube_shorts" | "postbridge">("tiktok");
  const [authMethod, setAuthMethod] = useState<"official" | "private" | "device">("official");
  const [groupId, setGroupId] = useState("");
  const [formatId, setFormatId] = useState("");

  const formats = useMemo(() => getImportFormats(platform, authMethod), [platform, authMethod]);
  const activeFormat = formats.find((f) => f.id === formatId) ?? formats[0];
  // Keep the selected format valid whenever platform/method changes.
  useEffect(() => {
    if (!formats.some((f) => f.id === formatId)) setFormatId(formats[0]?.id ?? "");
  }, [formats, formatId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accRes, grpRes] = await Promise.all([
        accountFarmApi.listAccounts({ limit: 100 }),
        accountFarmApi.listGroups(),
      ]);
      setData({ accounts: accRes.accounts, total: accRes.total });
      setGroups(grpRes);
    } catch (e: any) {
      setError(e.message ?? "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleImport = async () => {
    if (!activeFormat) { alert("Выберите формат"); return; }
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    let skipped = 0;
    const accounts = lines
      .map((line) => {
        const parsed = activeFormat.parse(line);
        if (!parsed) { skipped++; return null; }
        return { platform, authMethod, accountGroupId: groupId || undefined, ...parsed };
      })
      .filter(Boolean) as Array<Record<string, unknown>>;

    if (accounts.length === 0) {
      alert("Ни одной строки не распознано под выбранный формат — проверьте формат.");
      return;
    }
    setImporting(true);
    try {
      const res = await accountFarmApi.bulkImportAccounts({ accounts: accounts as any, autoAssign: true });
      const failed = res.results.filter((r) => r.status === "failed");
      const notes = res.results.filter((r) => r.note);
      let msg = `Импортировано: ${res.imported}.`;
      if (skipped) msg += ` Пропущено (не распознано): ${skipped}.`;
      if (failed.length) msg += `\nОшибок: ${failed.length} — ${failed.slice(0, 3).map((f) => `${f.accountName}: ${f.error}`).join("; ")}`;
      if (notes.length) msg += `\n⚠ ${notes.length} без сессии постинга: ${notes[0].note}`;
      alert(msg);
      setShowImport(false);
      setRaw("");
      load();
    } catch (e: any) {
      alert(e.message ?? "Import failed");
    } finally {
      setImporting(false);
    }
  };

  if (loading) return <CenterSpinner />;
  if (error) return <ErrorRetry error={error} onRetry={load} />;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-xs text-text-tertiary">{data?.total ?? 0} accounts</p>
        <Button variant="primary" size="sm" onClick={() => setShowImport(true)}>Bulk Import</Button>
      </div>

      {!data || data.accounts.length === 0 ? (
        <EmptyState title="No farm accounts" description="Bulk import social accounts with auto proxy + fingerprint assignment" />
      ) : (
        <div className="space-y-2">
          {data.accounts.map((a) => (
            <Card key={a.id}>
              <CardContent className="px-5 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {accountUrl(a.platform, a.accountName) ? (
                      <a href={accountUrl(a.platform, a.accountName)!} target="_blank" rel="noreferrer"
                        className="text-sm font-medium text-brand-400 hover:underline truncate">
                        {a.accountName} ↗
                      </a>
                    ) : (
                      <span className="text-sm font-medium text-text-primary truncate">{a.accountName}</span>
                    )}
                    <Badge variant="outline" className="text-2xs capitalize">{a.platform}</Badge>
                    {a.authMethod === "private" && <Badge variant="brand" className="text-2xs">private</Badge>}
                    {a.authMethod === "device" && <Badge variant="brand" className="text-2xs">device{a.deviceId ? ` · ${a.deviceId}` : ""}</Badge>}
                    {a.readiness && (a.readiness.canPublish
                      ? <Badge variant="success" className="text-2xs">готов к постингу</Badge>
                      : <Badge variant="danger" className="text-2xs">нельзя постить</Badge>)}
                    {a.shadowBanDetected && <Badge variant="danger" className="text-2xs">shadow-ban</Badge>}
                    {!a.isActive && <Badge variant="default" className="text-2xs">paused</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-text-tertiary mt-0.5">
                    {a.accountGroup?.name && <span>{a.accountGroup.name}</span>}
                    {a.proxy && <span>proxy {a.proxy.host}:{a.proxy.port}</span>}
                    {!a.proxy && <span className="text-warning">no proxy</span>}
                    <span>{a.dailyPostCount} today</span>
                    <span>warmup: {a.warmupStatus}</span>
                  </div>
                  {a.readiness && !a.readiness.canPublish && (
                    <p className="text-[11px] text-danger mt-0.5">{a.readiness.blockers.join(" · ")}</p>
                  )}
                  {a.readiness && a.readiness.canPublish && a.readiness.warnings.length > 0 && (
                    <p className="text-[11px] text-warning mt-0.5">{a.readiness.warnings.join(" · ")}</p>
                  )}
                </div>
                <HealthBadge score={a.healthScore} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showImport && (
        <Modal title="Bulk Import Accounts" onClose={() => setShowImport(false)}>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">Platform</label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as any)}
                className="w-full h-9 rounded-md border border-border bg-surface-0 px-2 text-sm text-text-primary"
              >
                <option value="tiktok">TikTok</option>
                <option value="instagram">Instagram</option>
                <option value="youtube_shorts">YouTube Shorts</option>
                <option value="postbridge">PostBridge</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">Method</label>
              <select
                value={authMethod}
                onChange={(e) => setAuthMethod(e.target.value as any)}
                className="w-full h-9 rounded-md border border-border bg-surface-0 px-2 text-sm text-text-primary"
              >
                <option value="official">Official API</option>
                <option value="private">Private (no API)</option>
                <option value="device">Device (реальный телефон, ADB)</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">Group (auto-assign)</label>
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className="w-full h-9 rounded-md border border-border bg-surface-0 px-2 text-sm text-text-primary"
              >
                <option value="">No group</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          </div>

          {(authMethod === "private" || authMethod === "device") && (platform === "youtube_shorts" || platform === "postbridge") && (
            <p className="text-xs text-warning">
              {authMethod === "private" ? "Приватный" : "Device"} метод поддерживается только для TikTok и Instagram. Для {platform} используйте Official API.
            </p>
          )}
          {authMethod === "device" && (
            <p className="text-xs text-text-secondary">
              Публикация идёт через реальный телефон в ферме (apps/device-agent по AmneziaWG-туннелю через ADB) —
              приложение должно быть уже залогинено на телефоне под этим аккаунтом. См.{" "}
              <code>docs/PHONE_FARM_INTEGRATION_PLAN.md</code>.
            </p>
          )}

          {/* Формат строки — выбор под конкретную выгрузку */}
          {formats.length > 1 && (
            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">Формат строки</label>
              <select
                value={activeFormat?.id ?? ""}
                onChange={(e) => setFormatId(e.target.value)}
                className="w-full h-9 rounded-md border border-border bg-surface-0 px-2 text-sm text-text-primary"
              >
                {formats.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </div>
          )}

          <p className="text-xs text-text-tertiary">
            По одной строке: <code>{activeFormat?.template}</code>. Всё шифруется at rest.
            {authMethod === "private" && <> Назначьте аккаунтам прокси (через группу).</>}
            {authMethod === "private" && platform === "tiktok" && activeFormat && !TIKTOK_POST_READY.has(activeFormat.id) && (
              <span className="block text-warning mt-1">
                ⚠ TikTok постит только по <code>sessionid</code>-куке. Логин/пароль/2FA/почта
                сохранятся зашифрованно, но чтобы аккаунт публиковал — добавьте ему sessionid
                (формат с cookies, «accountName:sessionId» или позже через правку аккаунта).
              </span>
            )}
            {authMethod === "private" && platform === "tiktok" && activeFormat?.id === "user_pass_mail_cookies" && (
              <span className="block text-text-secondary mt-1">
                Cookies целиком передаются в браузер для входа; <code>sessionid</code> автоматически
                извлекается из <code>sid_guard</code>. Экспорт должен быть полным — частичный набор
                кук может не пройти авторизацию (проверяется живым постингом).
              </span>
            )}
            {authMethod === "private" && platform === "instagram" && activeFormat?.id === "login_pass_tech_cookie" && (
              <span className="block text-text-secondary mt-1">
                Из <code>Cookie</code> автоматически берётся <code>sessionid</code> (переиспользование
                сессии без повторного логина); <code>Tech_data</code> сохраняется как параметры устройства.
              </span>
            )}
          </p>
          <Textarea
            label="Accounts"
            rows={8}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={activeFormat?.placeholder}
          />
          <ModalActions onCancel={() => setShowImport(false)} onConfirm={handleImport} loading={importing} disabled={!raw.trim()} confirmLabel="Import" />
        </Modal>
      )}
    </div>
  );
}

function HealthBadge({ score }: { score: number }) {
  const tone: "success" | "warning" | "danger" = score >= 70 ? "success" : score >= 40 ? "warning" : "danger";
  return <Badge variant={tone}>{score}/100</Badge>;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function CenterSpinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <LoadingSpinner size={32} />
    </div>
  );
}

function ErrorRetry({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <p className="text-text-secondary text-sm">{error}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
  maxWidth = "max-w-lg",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className={cn("w-full rounded-xl border border-border bg-surface-1 shadow-elevation-3 p-5 space-y-4 my-auto", maxWidth)}>
        <div className="flex items-center justify-between border-b border-border/50 pb-3">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary text-base p-1">✕</button>
        </div>
        <div className="space-y-4">{children}</div>
      </div>
    </div>
  );
}

function ModalActions({ onCancel, onConfirm, loading, disabled, confirmLabel }: { onCancel: () => void; onConfirm: () => void; loading?: boolean; disabled?: boolean; confirmLabel: string }) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" size="sm" loading={loading} disabled={disabled} onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  );
}

// ── Physical Phone Farm (Motherboard Rack) Tab ──────────────────────────────

function DevicesTab() {
  const [devices, setDevices] = useState<FarmDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [accounts, setAccounts] = useState<FarmSocialAccount[]>([]);

  const [checkingIp, setCheckingIp] = useState<Record<string, boolean>>({});
  const [ipResults, setIpResults] = useState<Record<string, DeviceIpCheck>>({});
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});

  // Modals
  const [selectedDevice, setSelectedDevice] = useState<FarmDevice | null>(null);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [proxyModalOpen, setProxyModalOpen] = useState(false);
  const [assignModalOpen, setAssignModalOpen] = useState(false);

  // Smart View form
  const [viewPlatform, setViewPlatform] = useState<'instagram' | 'tiktok'>('instagram');
  const [viewTargetUser, setViewTargetUser] = useState('');
  const [viewDuration, setViewDuration] = useState(25);
  const [viewScrollCount, setViewScrollCount] = useState(3);
  const [viewLikeProb, setViewLikeProb] = useState(0.3);
  const [viewCheckIp, setViewCheckIp] = useState(true);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewFeedback, setViewFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  // Wildberries Warmup form
  const [wbModalOpen, setWbModalOpen] = useState(false);
  const [wbSku, setWbSku] = useState('');
  const [wbDuration, setWbDuration] = useState(60);
  const [wbSwipePhotos, setWbSwipePhotos] = useState(true);
  const [wbReadReviews, setWbReadReviews] = useState(true);
  const [wbAddToFavorites, setWbAddToFavorites] = useState(true);
  const [wbCheckIp, setWbCheckIp] = useState(true);
  const [wbLoading, setWbLoading] = useState(false);
  const [wbFeedback, setWbFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  // Proxy modal form
  const [selectedProxyId, setSelectedProxyId] = useState<string>('');
  const [customHost, setCustomHost] = useState('');
  const [customPort, setCustomPort] = useState<number>(8080);
  const [customType, setCustomType] = useState<'http' | 'socks5' | 'mobile'>('http');
  const [proxySaving, setProxySaving] = useState(false);

  // Assign account modal form
  const [assignAccountId, setAssignAccountId] = useState<string>('');
  const [assignSaving, setAssignSaving] = useState(false);

  // Optimization & Telemetry Modals
  const [optimizing, setOptimizing] = useState(false);
  const [screenshotModalOpen, setScreenshotModalOpen] = useState(false);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotData, setScreenshotData] = useState<any>(null);
  const [healthModalOpen, setHealthModalOpen] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthData, setHealthData] = useState<BoardHealthInfo | null>(null);
  const [healing, setHealing] = useState(false);

  // Interactive Live Remote Control State (Master-Slave enabled)
  const [remoteModalOpen, setRemoteModalOpen] = useState(false);
  const [remoteLive, setRemoteLive] = useState(true);
  const [remoteFps, setRemoteFps] = useState<number>(1200);
  const [remoteScreenData, setRemoteScreenData] = useState<string | null>(null);
  const [remoteScreenLoading, setRemoteScreenLoading] = useState(false);
  const [remoteActionLoading, setRemoteActionLoading] = useState(false);
  const [remoteTouchRipple, setRemoteTouchRipple] = useState<{ x: number; y: number } | null>(null);
  const [remoteTextInput, setRemoteTextInput] = useState('');
  const [masterSlaveEnabled, setMasterSlaveEnabled] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; time: number } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [devRes, proxyRes, accRes] = await Promise.allSettled([
        accountFarmApi.listDevices(),
        accountFarmApi.listProxies(),
        accountFarmApi.listAccounts({ limit: 100 }),
      ]);

      if (proxyRes.status === 'fulfilled') setProxies(proxyRes.value);
      if (accRes.status === 'fulfilled') setAccounts(accRes.value.accounts);

      if (devRes.status === 'fulfilled') {
        const list = devRes.value.devices || [];
        // If empty (e.g. mock boards not yet connected), generate standard 20 motherboard rack placeholders
        if (list.length === 0) {
          const placeholders: FarmDevice[] = Array.from({ length: 20 }, (_, idx) => {
            const num = String(idx + 1).padStart(2, '0');
            const devId = `board_mb_${num}`;
            const linked = accRes.status === 'fulfilled' ? accRes.value.accounts.find((a) => a.deviceId === devId) : undefined;
            return {
              deviceId: devId,
              name: `Плата #${num} (Слот ${num})`,
              model: 'Android MB Cluster (Exynos/Snapdragon)',
              online: true,
              assignedAccount: linked ? {
                id: linked.id,
                accountName: linked.accountName,
                platform: linked.platform,
                healthScore: linked.healthScore,
                warmupStatus: linked.warmupStatus,
                warmupCount: linked.warmupCount ?? 0,
              } : null,
            };
          });
          setDevices(placeholders);
        } else {
          setDevices(list);
        }
      } else {
        const reason = devRes.reason instanceof Error ? devRes.reason.message : String(devRes.reason);
        setError(reason);
        // Provide mock boards view with offline warning
        const placeholders: FarmDevice[] = Array.from({ length: 20 }, (_, idx) => {
          const num = String(idx + 1).padStart(2, '0');
          return {
            deviceId: `board_mb_${num}`,
            name: `Плата #${num} (Слот ${num})`,
            model: 'Android MB Cluster (20 плат)',
            online: false,
          };
        });
        setDevices(placeholders);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCheckIp = async (deviceId: string) => {
    setCheckingIp((prev) => ({ ...prev, [deviceId]: true }));
    try {
      const res = await accountFarmApi.checkDeviceIp(deviceId);
      setIpResults((prev) => ({ ...prev, [deviceId]: res }));
    } catch (err: any) {
      setIpResults((prev) => ({
        ...prev,
        [deviceId]: { ok: false, error: err.message || 'Ошибка проверки IP', leakDetected: false },
      }));
    } finally {
      setCheckingIp((prev) => ({ ...prev, [deviceId]: false }));
    }
  };

  const handleReboot = async (deviceId: string) => {
    setActionStatus((prev) => ({ ...prev, [deviceId]: 'Перезагрузка...' }));
    try {
      await accountFarmApi.rebootDevice(deviceId);
      setActionStatus((prev) => ({ ...prev, [deviceId]: 'Команда отправлена' }));
      setTimeout(() => setActionStatus((prev) => ({ ...prev, [deviceId]: '' })), 3000);
    } catch (err: any) {
      setActionStatus((prev) => ({ ...prev, [deviceId]: `Ошибка: ${err.message}` }));
    }
  };

  const handleWake = async (deviceId: string) => {
    setActionStatus((prev) => ({ ...prev, [deviceId]: 'Пробуждение...' }));
    try {
      await accountFarmApi.wakeDevice(deviceId);
      setActionStatus((prev) => ({ ...prev, [deviceId]: 'Экран включен' }));
      setTimeout(() => setActionStatus((prev) => ({ ...prev, [deviceId]: '' })), 3000);
    } catch (err: any) {
      setActionStatus((prev) => ({ ...prev, [deviceId]: `Ошибка: ${err.message}` }));
    }
  };

  const handleSaveProxy = async () => {
    if (!selectedDevice) return;
    setProxySaving(true);
    try {
      if (selectedProxyId) {
        await accountFarmApi.setDeviceProxy(selectedDevice.deviceId, { proxyId: selectedProxyId });
      } else if (customHost && customPort) {
        await accountFarmApi.setDeviceProxy(selectedDevice.deviceId, {
          host: customHost,
          port: customPort,
          type: customType,
        });
      }
      setProxyModalOpen(false);
      await handleCheckIp(selectedDevice.deviceId);
      loadData();
    } catch (err: any) {
      alert(`Ошибка сохранения прокси: ${err.message}`);
    } finally {
      setProxySaving(false);
    }
  };

  const handleClearProxy = async (deviceId: string) => {
    if (!confirm('Сбросить прокси на этой плате?')) return;
    try {
      await accountFarmApi.clearDeviceProxy(deviceId);
      await handleCheckIp(deviceId);
      loadData();
    } catch (err: any) {
      alert(`Ошибка сброса: ${err.message}`);
    }
  };

  const handleAssignAccount = async () => {
    if (!selectedDevice || !assignAccountId) return;
    setAssignSaving(true);
    try {
      await accountFarmApi.assignDeviceAccount(selectedDevice.deviceId, assignAccountId);
      setAssignModalOpen(false);
      loadData();
    } catch (err: any) {
      alert(`Ошибка привязки: ${err.message}`);
    } finally {
      setAssignSaving(false);
    }
  };

  const handleRunSmartView = async () => {
    if (!selectedDevice || !viewTargetUser.trim()) return;
    setViewLoading(true);
    setViewFeedback(null);
    try {
      const res = await accountFarmApi.viewTarget(selectedDevice.deviceId, {
        platform: viewPlatform,
        targetUsername: viewTargetUser.trim(),
        watchDurationSeconds: viewDuration,
        scrollCount: viewScrollCount,
        likeProbability: viewLikeProb,
        checkIpFirst: viewCheckIp,
      });

      if (res.ok) {
        setViewFeedback({
          ok: true,
          message: `Успешно! Просмотрено роликов: ${res.stats?.scrollCount || viewScrollCount}, время удержания: ~${res.stats?.baseWatchSeconds || viewDuration}с`,
        });
        loadData();
      } else {
        setViewFeedback({
          ok: false,
          message: res.detail || 'Сценарий завершился с ошибкой',
        });
      }
    } catch (err: any) {
      setViewFeedback({
        ok: false,
        message: err.message || 'Ошибка вызова сценария Smart View',
      });
    } finally {
      setViewLoading(false);
    }
  };

  const handleRunWbWarmup = async () => {
    if (!selectedDevice || !wbSku.trim()) return;
    setWbLoading(true);
    setWbFeedback(null);
    try {
      const res = await accountFarmApi.wbWarmup(selectedDevice.deviceId, {
        sku: wbSku.trim(),
        dwellDurationSeconds: wbDuration,
        swipePhotos: wbSwipePhotos,
        readReviews: wbReadReviews,
        addToFavorites: wbAddToFavorites,
        checkIpFirst: wbCheckIp,
      });

      if (res.ok) {
        setWbFeedback({
          ok: true,
          message: `Успешно! Карточка WB (арт. ${res.sku}) прогрета на плате. Время удержания: ~${res.stats?.dwellSeconds || wbDuration}с, фото: ${res.stats?.photosSwiped || 0}, избранное: ${res.stats?.addedToFavorites ? '✓ Добавлено' : '—'}`,
        });
        loadData();
      } else {
        setWbFeedback({
          ok: false,
          message: res.detail || 'Сценарий прогрева WB завершился с ошибкой',
        });
      }
    } catch (err: any) {
      setWbFeedback({
        ok: false,
        message: err.message || 'Ошибка вызова прогрева Wildberries',
      });
    } finally {
      setWbLoading(false);
    }
  };

  const handleOptimizeFarm = async () => {
    if (!confirm('Применить режим 24/7 ко всей стойке плат? Будет отключен таймаут сна, сняты экраны блокировки и закрыты зависшие окна.')) return;
    setOptimizing(true);
    try {
      const res = await accountFarmApi.optimizeFarm();
      alert(`Стойка оптимизирована! Успешно обработано плат: ${res.total || res.results?.length || devices.length}`);
      loadData();
    } catch (err: any) {
      alert(`Ошибка оптимизации: ${err.message}`);
    } finally {
      setOptimizing(false);
    }
  };

  const handleScreenshot = async (device: FarmDevice) => {
    setSelectedDevice(device);
    setScreenshotModalOpen(true);
    setScreenshotLoading(true);
    setScreenshotData(null);
    try {
      const res = await accountFarmApi.screenshotDevice(device.deviceId);
      if (res.ok) {
        setScreenshotData(res.data);
      } else {
        alert(`Ошибка получения скриншота: ${res.error || 'Сбой захвата'}`);
      }
    } catch (err: any) {
      alert(`Ошибка: ${err.message}`);
    } finally {
      setScreenshotLoading(false);
    }
  };

  const handleHealth = async (device: FarmDevice) => {
    setSelectedDevice(device);
    setHealthModalOpen(true);
    setHealthLoading(true);
    setHealthData(null);
    try {
      const res = await accountFarmApi.getDeviceHealth(device.deviceId);
      setHealthData(res);
    } catch (err: any) {
      alert(`Ошибка диагностики: ${err.message}`);
    } finally {
      setHealthLoading(false);
    }
  };

  const handleHealBoard = async (deviceId: string) => {
    setHealing(true);
    try {
      const res = await accountFarmApi.healDevice(deviceId);
      if (res.ok) {
        alert(res.message || 'Плата успешно стабилизирована');
        const h = await accountFarmApi.getDeviceHealth(deviceId);
        setHealthData(h);
      } else {
        alert(`Ошибка стабилизации: ${res.error || 'Сбой команды'}`);
      }
    } catch (err: any) {
      alert(`Ошибка: ${err.message}`);
    } finally {
      setHealing(false);
    }
  };

  const handleOpenRemote = (device: FarmDevice) => {
    setSelectedDevice(device);
    setRemoteModalOpen(true);
    setRemoteScreenData(null);
    setRemoteTouchRipple(null);
    setDragStart(null);
  };

  const refreshRemoteFrame = useCallback(async () => {
    if (!selectedDevice) return;
    setRemoteScreenLoading(true);
    try {
      const res = await accountFarmApi.screenshotDevice(selectedDevice.deviceId);
      if (res.ok && res.data) {
        const raw = (res.data as any).data || res.data;
        if (typeof raw === 'string') {
          const s = raw.trim();
          setRemoteScreenData(s.startsWith('data:image') || s.startsWith('http') ? s : `data:image/png;base64,${s}`);
        }
      }
    } catch {
      // silent retry on frame capture
    } finally {
      setRemoteScreenLoading(false);
    }
  }, [selectedDevice]);

  useEffect(() => {
    if (!remoteModalOpen || !selectedDevice) return;
    refreshRemoteFrame();
    if (!remoteLive) return;
    const interval = setInterval(refreshRemoteFrame, remoteFps);
    return () => clearInterval(interval);
  }, [remoteModalOpen, selectedDevice, remoteLive, remoteFps, refreshRemoteFrame]);

  const getTargetDeviceIds = useCallback(() => {
    if (!masterSlaveEnabled || !selectedDevice) return undefined;
    return devices
      .filter((d) => d.online && d.deviceId !== selectedDevice.deviceId)
      .map((d) => d.deviceId);
  }, [masterSlaveEnabled, selectedDevice, devices]);

  const handleRemoteMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xPercent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const yPercent = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setDragStart({ x: xPercent, y: yPercent, time: Date.now() });
  };

  const handleRemoteMouseUp = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragStart || !selectedDevice) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xPercent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const yPercent = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    const deltaX = Math.abs(xPercent - dragStart.x);
    const deltaY = Math.abs(yPercent - dragStart.y);
    const duration = Math.max(100, Math.min(1500, Date.now() - dragStart.time));
    const targets = getTargetDeviceIds();

    setDragStart(null);

    if (deltaX < 0.03 && deltaY < 0.03) {
      setRemoteTouchRipple({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      setTimeout(() => setRemoteTouchRipple(null), 400);

      try {
        await accountFarmApi.tapDevice(selectedDevice.deviceId, {
          xPercent: dragStart.x,
          yPercent: dragStart.y,
          targetDeviceIds: targets,
        });
        setTimeout(refreshRemoteFrame, 250);
      } catch (err: any) {
        console.error('Remote tap error:', err);
      }
    } else {
      try {
        await accountFarmApi.swipeDevice(selectedDevice.deviceId, {
          x1Percent: dragStart.x,
          y1Percent: dragStart.y,
          x2Percent: xPercent,
          y2Percent: yPercent,
          durationMs: duration,
          targetDeviceIds: targets,
        });
        setTimeout(refreshRemoteFrame, 350);
      } catch (err: any) {
        console.error('Remote swipe error:', err);
      }
    }
  };

  const handleRemoteKey = async (key: 'home' | 'back' | 'recents' | 'power' | 'wake' | 'volup' | 'voldown') => {
    if (!selectedDevice) return;
    setRemoteActionLoading(true);
    try {
      await accountFarmApi.sendDeviceKey(selectedDevice.deviceId, key, getTargetDeviceIds());
      setTimeout(refreshRemoteFrame, 250);
    } catch (err: any) {
      alert(`Ошибка кнопки: ${err.message}`);
    } finally {
      setRemoteActionLoading(false);
    }
  };

  const handleRemoteSendText = async () => {
    if (!selectedDevice || !remoteTextInput.trim()) return;
    setRemoteActionLoading(true);
    try {
      await accountFarmApi.sendDeviceText(selectedDevice.deviceId, remoteTextInput.trim(), getTargetDeviceIds());
      setRemoteTextInput('');
      setTimeout(refreshRemoteFrame, 300);
    } catch (err: any) {
      alert(`Ошибка ввода текста: ${err.message}`);
    } finally {
      setRemoteActionLoading(false);
    }
  };

  const handleRemoteOpenApp = async (pkg: string) => {
    if (!selectedDevice) return;
    setRemoteActionLoading(true);
    try {
      await accountFarmApi.openDeviceApp(selectedDevice.deviceId, pkg, getTargetDeviceIds());
      setTimeout(refreshRemoteFrame, 800);
    } catch (err: any) {
      alert(`Ошибка открытия приложения: ${err.message}`);
    } finally {
      setRemoteActionLoading(false);
    }
  };

  if (loading) return <LoadingSpinner size={32} />;

  const onlineCount = devices.filter((d) => d.online).length;
  const withProxyCount = devices.filter((d) => d.proxy).length;
  const withAccountCount = devices.filter((d) => d.assignedAccount).length;

  return (
    <div className="space-y-6">
      {/* Overview Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-surface-2 border-border/60">
          <CardContent className="p-4 space-y-1">
            <p className="text-xs text-text-tertiary">Всего плат в стойке</p>
            <p className="text-2xl font-bold text-text-primary">{devices.length}</p>
            <p className="text-[11px] text-text-secondary">Стойка motherboards (rack 20)</p>
          </CardContent>
        </Card>
        <Card className="bg-surface-2 border-border/60">
          <CardContent className="p-4 space-y-1">
            <p className="text-xs text-text-tertiary">Платы онлайн</p>
            <p className="text-2xl font-bold text-emerald-400">{onlineCount} / {devices.length}</p>
            <p className="text-[11px] text-text-secondary">Готовы к публикациям и просмотру</p>
          </CardContent>
        </Card>
        <Card className="bg-surface-2 border-border/60">
          <CardContent className="p-4 space-y-1">
            <p className="text-xs text-text-tertiary">С выделенным прокси</p>
            <p className="text-2xl font-bold text-brand-400">{withProxyCount}</p>
            <p className="text-[11px] text-text-secondary">Защита от пересечения IP</p>
          </CardContent>
        </Card>
        <Card className="bg-surface-2 border-border/60">
          <CardContent className="p-4 space-y-1">
            <p className="text-xs text-text-tertiary">Привязано аккаунтов</p>
            <p className="text-2xl font-bold text-indigo-400">{withAccountCount}</p>
            <p className="text-[11px] text-text-secondary">Instagram & TikTok профили</p>
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs space-y-2">
          <div className="flex items-center gap-2 font-semibold">
            <span>⚠️</span>
            <span>Статус соединения с мостом фермы (AmneziaWG / device-agent):</span>
          </div>
          <p className="text-text-secondary">{error}</p>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={loadData}>Повторить опрос</Button>
          </div>
        </div>
      )}

      {/* Control Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-2/60 p-4 rounded-xl border border-border">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-text-primary">Пул физических плат стойки</h2>
          <Badge variant="outline" className="text-xs">20 устройств</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            loading={optimizing}
            onClick={handleOptimizeFarm}
            className="border-brand-500/40 text-brand-400 hover:bg-brand-500/10"
          >
            ⚡ Оптимизировать стойку (Keep-Alive 24/7)
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              devices.forEach((d) => handleCheckIp(d.deviceId));
            }}
          >
            🔍 Проверить IP на всех платах
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              const firstOnline = devices.find((d) => d.online) || devices[0];
              setSelectedDevice(firstOnline);
              setViewModalOpen(true);
            }}
          >
            👁 Smart View (Органический просмотр)
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="bg-purple-600 hover:bg-purple-500 text-white"
            onClick={() => {
              const firstOnline = devices.find((d) => d.online) || devices[0];
              setSelectedDevice(firstOnline);
              setWbModalOpen(true);
            }}
          >
            🛍️ Прогрев карточки WB
          </Button>
          <Button size="sm" variant="ghost" onClick={loadData}>🔄 Обновить</Button>
        </div>
      </div>

      {/* 20 Boards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {devices.map((device, idx) => {
          const check = ipResults[device.deviceId];
          const isChecking = checkingIp[device.deviceId];
          const statusMsg = actionStatus[device.deviceId];

          return (
            <Card
              key={device.deviceId}
              className={cn(
                "relative transition-all border",
                device.online
                  ? "border-border/80 bg-surface-2 hover:border-brand-500/50"
                  : "border-border/40 bg-surface-2/40 opacity-75"
              )}
            >
              <CardContent className="p-4 space-y-3">
                {/* Board Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "w-2.5 h-2.5 rounded-full",
                        device.online ? "bg-emerald-500 shadow-sm shadow-emerald-500/50" : "bg-zinc-600"
                      )}
                    />
                    <span className="text-xs font-bold text-text-primary">
                      {device.name || `Плата #${idx + 1}`}
                    </span>
                  </div>
                  <Badge variant={device.online ? "success" : "default"} className="text-[10px] px-1.5 py-0.5">
                    {device.online ? "Онлайн" : "Оффлайн"}
                  </Badge>
                </div>

                <div className="text-[11px] text-text-tertiary font-mono truncate">
                  ID: {device.deviceId}
                </div>

                {/* Assigned Social Account */}
                <div className="p-2.5 rounded-lg bg-surface-3/60 border border-border/40 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-text-tertiary">Аккаунт</span>
                    {device.assignedAccount ? (
                      <span className="text-[11px] font-semibold text-brand-400 capitalize">
                        {device.assignedAccount.platform}
                      </span>
                    ) : (
                      <button
                        onClick={() => {
                          setSelectedDevice(device);
                          setAssignModalOpen(true);
                        }}
                        className="text-[11px] text-brand-400 hover:underline"
                      >
                        + Привязать
                      </button>
                    )}
                  </div>

                  {device.assignedAccount ? (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-text-primary truncate">
                          @{device.assignedAccount.accountName}
                        </span>
                        <Badge variant="outline" className="text-[10px]">
                          {device.assignedAccount.warmupStatus === 'warm' ? '🔥 Warm' : (device.assignedAccount.warmupStatus === 'warming' ? '☕ Warming' : '❄️ Cold')}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-text-secondary">
                        <span>Здоровье: {device.assignedAccount.healthScore}%</span>
                        <span>Действий: {device.assignedAccount.warmupCount}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-text-secondary italic">Слот свободен для привязки</p>
                  )}
                </div>

                {/* Network & Proxy Status */}
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-text-tertiary text-[11px]">Прокси:</span>
                    {device.proxy ? (
                      <span className="text-[11px] font-mono text-emerald-400 truncate max-w-[140px]">
                        {device.proxy.host}:{device.proxy.port}
                      </span>
                    ) : (
                      <span className="text-[11px] text-amber-400/80">Не задан</span>
                    )}
                  </div>

                  {/* IP Check result */}
                  {check && (
                    <div className="text-[11px] rounded p-1.5 bg-surface-1 border border-border/50">
                      {check.ok ? (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between font-mono">
                            <span className="text-text-primary">{check.ip}</span>
                            {check.country && <span className="text-text-secondary">[{check.country}]</span>}
                          </div>
                          {check.leakDetected && (
                            <p className="text-[10px] text-rose-400 font-bold animate-pulse">
                              ⚠️ УТЕЧКА: IP совпадает с домашним!
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-rose-400 text-[10px] truncate block">
                          {check.error || 'Ошибка проверки IP'}
                        </span>
                      )}
                    </div>
                  )}

                  {statusMsg && (
                    <p className="text-[10px] text-brand-400 font-medium">{statusMsg}</p>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="grid grid-cols-2 gap-1.5 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] py-1 h-auto"
                    loading={isChecking}
                    onClick={() => handleCheckIp(device.deviceId)}
                  >
                    🔍 Тест IP
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] py-1 h-auto"
                    onClick={() => {
                      setSelectedDevice(device);
                      setProxyModalOpen(true);
                    }}
                  >
                    🌐 Прокси
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    className="col-span-2 text-[11px] py-1.5 h-auto bg-brand-600 hover:bg-brand-500"
                    onClick={() => {
                      setSelectedDevice(device);
                      setViewModalOpen(true);
                    }}
                  >
                  <Button
                    size="sm"
                    variant="primary"
                    className="col-span-2 text-[11px] py-1.5 h-auto bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center justify-center gap-1.5 shadow-sm"
                    onClick={() => handleOpenRemote(device)}
                  >
                    🎮 Пульт (Live)
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="col-span-2 text-[11px] py-1.5 h-auto bg-purple-600/20 border-purple-500/40 hover:bg-purple-500/30 text-purple-300"
                    onClick={() => {
                      setSelectedDevice(device);
                      setWbModalOpen(true);
                    }}
                  >
                    🛍️ Прогрев WB
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="col-span-2 text-[11px] py-1.5 h-auto bg-brand-600/20 border-brand-500/40 hover:bg-brand-500/30 text-brand-300"
                    onClick={() => {
                      setSelectedDevice(device);
                      setViewModalOpen(true);
                    }}
                  >
                    👁 Smart View
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] py-1 h-auto"
                    onClick={() => handleScreenshot(device)}
                  >
                    📸 Снимок
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] py-1 h-auto"
                    onClick={() => handleHealth(device)}
                  >
                    🩺 Инфо
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-[10px] py-1 h-auto"
                    onClick={() => handleWake(device.deviceId)}
                  >
                    💡 Разбудить
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-[10px] py-1 h-auto text-rose-400 hover:text-rose-300"
                    onClick={() => handleReboot(device.deviceId)}
                  >
                    🔄 Ребут
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Smart View Modal */}
      {viewModalOpen && selectedDevice && (
        <Modal
          title={`Smart View: Автопросмотр видео на плате ${selectedDevice.name}`}
          onClose={() => {
            setViewModalOpen(false);
            setViewFeedback(null);
          }}
        >
          <div className="space-y-4 text-xs">
            <p className="text-text-secondary">
              Плата автоматически запустит приложение соцсети, откроет профиль целевого аккаунта,
              будет просматривать видео с органическим удержанием, ставить лайки и скроллить.
            </p>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setViewPlatform('instagram')}
                className={cn(
                  "p-2.5 rounded-lg border text-center font-medium",
                  viewPlatform === 'instagram'
                    ? "border-brand-500 bg-brand-500/10 text-brand-400"
                    : "border-border bg-surface-2 text-text-secondary"
                )}
              >
                📸 Instagram Reels
              </button>
              <button
                type="button"
                onClick={() => setViewPlatform('tiktok')}
                className={cn(
                  "p-2.5 rounded-lg border text-center font-medium",
                  viewPlatform === 'tiktok'
                    ? "border-brand-500 bg-brand-500/10 text-brand-400"
                    : "border-border bg-surface-2 text-text-secondary"
                )}
              >
                🎵 TikTok Video
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-text-primary font-medium">Username целевого аккаунта:</label>
              <Input
                placeholder="например: wildberries_brand (без @)"
                value={viewTargetUser}
                onChange={(e) => setViewTargetUser(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-text-secondary">Удержание (сек):</label>
                <Input
                  type="number"
                  min={10}
                  max={120}
                  value={viewDuration}
                  onChange={(e) => setViewDuration(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1">
                <label className="text-text-secondary">Число видео (скроллов):</label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={viewScrollCount}
                  onChange={(e) => setViewScrollCount(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-text-secondary">Вероятность лайка: {Math.round(viewLikeProb * 100)}%</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={viewLikeProb}
                onChange={(e) => setViewLikeProb(Number(e.target.value))}
                className="w-full accent-brand-500"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="checkIpFirst"
                checked={viewCheckIp}
                onChange={(e) => setViewCheckIp(e.target.checked)}
                className="rounded border-border accent-brand-500"
              />
              <label htmlFor="checkIpFirst" className="text-text-secondary cursor-pointer">
                Защита: проверять IP перед запуском (блокировать при утечке)
              </label>
            </div>

            {viewFeedback && (
              <div
                className={cn(
                  "p-3 rounded-lg text-xs font-medium border",
                  viewFeedback.ok
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                    : "bg-rose-500/10 border-rose-500/30 text-rose-300"
                )}
              >
                {viewFeedback.message}
              </div>
            )}
          </div>

          <ModalActions
            onCancel={() => {
              setViewModalOpen(false);
              setViewFeedback(null);
            }}
            onConfirm={handleRunSmartView}
            confirmLabel="Запустить просмотр на плате"
            loading={viewLoading}
            disabled={!viewTargetUser.trim()}
          />
        </Modal>
      )}

      {/* Wildberries Warmup Modal */}
      {wbModalOpen && selectedDevice && (
        <Modal
          title={`🛍️ Прогрев Wildberries: ${selectedDevice.name}`}
          onClose={() => {
            setWbModalOpen(false);
            setWbFeedback(null);
          }}
        >
          <div className="space-y-4 text-xs">
            <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-300">
              <p className="font-semibold mb-1">Органический прогрев карточки Wildberries (ПФ)</p>
              <p className="text-text-secondary text-[11px]">
                Плата откроет карточку товара через мобильное приложение Wildberries, полистает галерею фотографий, изучит описание и отзывы, задержится на карточке и добавит товар в избранное.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-text-primary font-medium">Артикул товара WB или ссылка:</label>
              <Input
                placeholder="например: 1145510159 или https://www.wildberries.ru/catalog/..."
                value={wbSku}
                onChange={(e) => setWbSku(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label className="text-text-secondary">Время удержания в карточке (сек):</label>
              <Input
                type="number"
                min={15}
                max={300}
                value={wbDuration}
                onChange={(e) => setWbDuration(Number(e.target.value))}
              />
              <p className="text-[10px] text-text-tertiary">Рекомендуется 60–120 секунд для максимального веса поведенческого фактора.</p>
            </div>

            <div className="space-y-2 pt-1 border-t border-border">
              <label className="text-text-primary font-medium block">Действия в карточке товара:</label>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="wbSwipePhotos"
                  checked={wbSwipePhotos}
                  onChange={(e) => setWbSwipePhotos(e.target.checked)}
                  className="rounded border-border accent-purple-500"
                />
                <label htmlFor="wbSwipePhotos" className="text-text-secondary cursor-pointer">
                  Листать галерею фотографий товара (2–4 свайпа)
                </label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="wbReadReviews"
                  checked={wbReadReviews}
                  onChange={(e) => setWbReadReviews(e.target.checked)}
                  className="rounded border-border accent-purple-500"
                />
                <label htmlFor="wbReadReviews" className="text-text-secondary cursor-pointer">
                  Скроллить к характеристикам и отзывам покупателей
                </label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="wbAddToFavorites"
                  checked={wbAddToFavorites}
                  onChange={(e) => setWbAddToFavorites(e.target.checked)}
                  className="rounded border-border accent-purple-500"
                />
                <label htmlFor="wbAddToFavorites" className="text-text-secondary cursor-pointer">
                  Добавить товар в избранное (лайк / сердечко)
                </label>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="wbCheckIp"
                  checked={wbCheckIp}
                  onChange={(e) => setWbCheckIp(e.target.checked)}
                  className="rounded border-border accent-purple-500"
                />
                <label htmlFor="wbCheckIp" className="text-text-secondary cursor-pointer">
                  Anti-Leak: проверять мобильный прокси перед запуском WB
                </label>
              </div>
            </div>

            {wbFeedback && (
              <div
                className={cn(
                  "p-3 rounded-lg text-xs font-medium border",
                  wbFeedback.ok
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                    : "bg-rose-500/10 border-rose-500/30 text-rose-300"
                )}
              >
                {wbFeedback.message}
              </div>
            )}
          </div>

          <ModalActions
            onCancel={() => {
              setWbModalOpen(false);
              setWbFeedback(null);
            }}
            onConfirm={handleRunWbWarmup}
            confirmLabel="Запустить прогрев WB на плате"
            loading={wbLoading}
            disabled={!wbSku.trim()}
          />
        </Modal>
      )}

      {/* Proxy Modal */}
      {proxyModalOpen && selectedDevice && (
        <Modal
          title={`Настройка прокси для платы ${selectedDevice.name}`}
          onClose={() => setProxyModalOpen(false)}
        >
          <div className="space-y-4 text-xs">
            <p className="text-text-secondary">
              Укажите прокси, через который плата будет выходить в сеть для работы Instagram и TikTok.
            </p>

            {proxies.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-text-primary font-medium">Выбрать из базы прокси организации:</label>
                <select
                  value={selectedProxyId}
                  onChange={(e) => {
                    setSelectedProxyId(e.target.value);
                    if (e.target.value) {
                      setCustomHost('');
                    }
                  }}
                  className="w-full bg-surface-2 border border-border rounded-lg p-2 text-text-primary text-xs"
                >
                  <option value="">-- Ввести вручную --</option>
                  {proxies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.type.toUpperCase()} - {p.host}:{p.port} ({p.country || 'Global'})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {!selectedProxyId && (
              <div className="space-y-3 pt-1 border-t border-border">
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2 space-y-1">
                    <label className="text-text-secondary">Host / IP:</label>
                    <Input
                      placeholder="185.x.x.x"
                      value={customHost}
                      onChange={(e) => setCustomHost(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-text-secondary">Порт:</label>
                    <Input
                      type="number"
                      placeholder="8080"
                      value={customPort}
                      onChange={(e) => setCustomPort(Number(e.target.value))}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-text-secondary">Тип:</label>
                  <select
                    value={customType}
                    onChange={(e) => setCustomType(e.target.value as any)}
                    className="w-full bg-surface-2 border border-border rounded-lg p-2 text-text-primary text-xs"
                  >
                    <option value="http">HTTP / HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="mobile">Мобильный 4G/LTE</option>
                  </select>
                </div>
              </div>
            )}

            {selectedDevice.proxy && (
              <div className="pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-rose-400 border-rose-500/30"
                  onClick={() => handleClearProxy(selectedDevice.deviceId)}
                >
                  Сбросить текущий прокси платы
                </Button>
              </div>
            )}
          </div>

          <ModalActions
            onCancel={() => setProxyModalOpen(false)}
            onConfirm={handleSaveProxy}
            confirmLabel="Применить и проверить"
            loading={proxySaving}
            disabled={!selectedProxyId && !customHost}
          />
        </Modal>
      )}

      {/* Assign Account Modal */}
      {assignModalOpen && selectedDevice && (
        <Modal
          title={`Привязка аккаунта к плате ${selectedDevice.name}`}
          onClose={() => setAssignModalOpen(false)}
        >
          <div className="space-y-4 text-xs">
            <p className="text-text-secondary">
              Выберите соцсеть и профиль, который авторизован на физическом телефоне в этом слоте.
            </p>

            <div className="space-y-1.5">
              <label className="text-text-primary font-medium">Аккаунт из базы:</label>
              <select
                value={assignAccountId}
                onChange={(e) => setAssignAccountId(e.target.value)}
                className="w-full bg-surface-2 border border-border rounded-lg p-2 text-text-primary text-xs"
              >
                <option value="">-- Выберите аккаунт --</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    [{acc.platform.toUpperCase()}] @{acc.accountName} ({acc.warmupStatus}, {acc.healthScore}%)
                  </option>
                ))}
              </select>
            </div>
          </div>

          <ModalActions
            onCancel={() => setAssignModalOpen(false)}
            onConfirm={handleAssignAccount}
            confirmLabel="Привязать аккаунт"
            loading={assignSaving}
            disabled={!assignAccountId}
          />
        </Modal>
      )}

      {/* Interactive Live Remote Control Modal (Master-Slave enabled) */}
      {remoteModalOpen && selectedDevice && (
        <Modal
          title={`🎮 Пульт управления (Live): ${selectedDevice.name} (${selectedDevice.deviceId})`}
          maxWidth="max-w-4xl"
          onClose={() => {
            setRemoteModalOpen(false);
            setRemoteScreenData(null);
            setRemoteTouchRipple(null);
            setDragStart(null);
          }}
        >
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
            {/* LEFT: Interactive Phone Screen & Navigation Bar */}
            <div className="md:col-span-5 flex flex-col items-center">
              {/* Phone Frame */}
              <div className="relative w-[280px] sm:w-[300px] aspect-[9/18.5] bg-zinc-950 rounded-[32px] border-4 border-zinc-700 shadow-2xl p-2.5 flex flex-col items-center justify-between overflow-hidden select-none">
                {/* Top Notch / Speaker */}
                <div className="w-20 h-3.5 bg-zinc-800 rounded-full mb-1 flex items-center justify-center gap-2 z-10">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                  <span className="w-8 h-1 rounded-full bg-zinc-700" />
                </div>

                {/* Screen Viewport with Mouse Event Handling */}
                <div
                  className="relative flex-1 w-full bg-zinc-900 rounded-2xl overflow-hidden flex items-center justify-center cursor-crosshair group select-none border border-zinc-800"
                  onMouseDown={handleRemoteMouseDown}
                  onMouseUp={handleRemoteMouseUp}
                >
                  {remoteScreenLoading && !remoteScreenData ? (
                    <div className="flex flex-col items-center gap-2">
                      <LoadingSpinner size={28} />
                      <span className="text-[11px] text-zinc-400">Подключение видеопотока...</span>
                    </div>
                  ) : remoteScreenData ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={remoteScreenData}
                      alt="Экран платы"
                      className="w-full h-full object-contain pointer-events-none select-none"
                      draggable={false}
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2 p-4 text-center">
                      <span className="text-2xl">📱</span>
                      <span className="text-xs text-zinc-400">Нажмите «Обновить кадр» для запуска</span>
                    </div>
                  )}

                  {/* Touch Ripple Effect */}
                  {remoteTouchRipple && (
                    <span
                      className="absolute w-8 h-8 rounded-full border-2 border-emerald-400 bg-emerald-400/40 pointer-events-none animate-ping -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${remoteTouchRipple.x}px`, top: `${remoteTouchRipple.y}px` }}
                    />
                  )}

                  {/* Live Status Indicator Badge */}
                  <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur text-[10px] text-zinc-300 pointer-events-none">
                    <span className={cn("w-1.5 h-1.5 rounded-full", remoteLive ? "bg-emerald-500 animate-pulse" : "bg-zinc-500")} />
                    <span>{remoteLive ? "LIVE" : "PAUSED"}</span>
                  </div>
                </div>

                {/* Bottom Android Navigation Bar */}
                <div className="w-full pt-2 flex items-center justify-around px-4 gap-2 z-10">
                  <button
                    onClick={() => handleRemoteKey('back')}
                    disabled={remoteActionLoading}
                    title="Назад (Back)"
                    className="flex-1 py-1.5 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-300 hover:text-white transition-all text-xs font-bold"
                  >
                    ◀
                  </button>
                  <button
                    onClick={() => handleRemoteKey('home')}
                    disabled={remoteActionLoading}
                    title="Домой (Home)"
                    className="flex-1 py-1.5 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-300 hover:text-white transition-all text-xs font-bold"
                  >
                    ⏺
                  </button>
                  <button
                    onClick={() => handleRemoteKey('recents')}
                    disabled={remoteActionLoading}
                    title="Недавние приложения (Recent Apps)"
                    className="flex-1 py-1.5 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-300 hover:text-white transition-all text-xs font-bold"
                  >
                    ⏹
                  </button>
                </div>
              </div>

              <p className="text-[11px] text-text-tertiary mt-2 text-center">
                Клик — касание (tap). Зажатие и протяжка — свайп (swipe).
              </p>
            </div>

            {/* RIGHT: Control Hub & Master-Slave Panel */}
            <div className="md:col-span-7 space-y-4">
              {/* 1. Master-Slave Synchronization Card */}
              <div className={cn(
                "p-4 rounded-xl border transition-all space-y-2",
                masterSlaveEnabled
                  ? "border-amber-500/60 bg-amber-500/10 shadow-lg shadow-amber-500/5"
                  : "border-border bg-surface-2"
              )}>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={masterSlaveEnabled}
                      onChange={(e) => setMasterSlaveEnabled(e.target.checked)}
                      className="w-4 h-4 rounded text-amber-500 focus:ring-amber-400 border-border bg-surface-3 cursor-pointer"
                    />
                    <span className="text-xs font-bold text-text-primary">
                      ⚡ Master-Slave Control (Зеркалирование)
                    </span>
                  </label>
                  {masterSlaveEnabled && (
                    <Badge variant="warning" className="text-[10px] animate-pulse">
                      Синхронизировано: {devices.filter(d => d.online).length} плат
                    </Badge>
                  )}
                </div>
                <p className="text-[11px] text-text-secondary">
                  {masterSlaveEnabled
                    ? "ВНИМАНИЕ: Все ваши клики, свайпы, ввод текста и нажатия кнопок на этой плате параллельно повторяются на ВСЕХ онлайн-платах стойки!"
                    : "Включите, чтобы параллельно повторять все действия мастера на всех остальных платах фермы с нормализацией координат."}
                </p>
              </div>

              {/* 2. Keyboard Text Input Card */}
              <div className="p-3.5 rounded-xl border border-border bg-surface-2 space-y-2">
                <label className="text-xs font-semibold text-text-primary flex items-center justify-between">
                  <span>⌨️ Синхронный ввод текста</span>
                  <span className="text-[10px] text-text-tertiary">В активное поле ввода</span>
                </label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Введите текст для отправки на устройство..."
                    value={remoteTextInput}
                    onChange={(e) => setRemoteTextInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleRemoteSendText();
                      }
                    }}
                    className="text-xs"
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={handleRemoteSendText}
                    loading={remoteActionLoading}
                    disabled={!remoteTextInput.trim()}
                    className="whitespace-nowrap bg-indigo-600 hover:bg-indigo-500"
                  >
                    Отправить
                  </Button>
                </div>
              </div>

              {/* 3. Quick System Actions */}
              <div className="p-3.5 rounded-xl border border-border bg-surface-2 space-y-2">
                <label className="text-xs font-semibold text-text-primary">⚡ Системные горячие клавиши</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px]"
                    onClick={() => handleRemoteKey('wake')}
                    disabled={remoteActionLoading}
                  >
                    💡 Разбудить
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px]"
                    onClick={() => handleRemoteKey('power')}
                    disabled={remoteActionLoading}
                  >
                    🔒 Питание
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px]"
                    onClick={() => handleRemoteKey('volup')}
                    disabled={remoteActionLoading}
                  >
                    🔊 Громкость +
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px]"
                    onClick={() => handleRemoteKey('voldown')}
                    disabled={remoteActionLoading}
                  >
                    🔉 Громкость -
                  </Button>
                </div>
              </div>

              {/* 4. Fast App Launcher */}
              <div className="p-3.5 rounded-xl border border-border bg-surface-2 space-y-2">
                <label className="text-xs font-semibold text-text-primary">🚀 Быстрый запуск приложений</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] border-purple-500/40 text-purple-400 hover:bg-purple-500/10"
                    onClick={() => handleRemoteOpenApp('com.wildberries.ru')}
                    disabled={remoteActionLoading}
                  >
                    🛍️ Wildberries
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] border-pink-500/40 text-pink-400 hover:bg-pink-500/10"
                    onClick={() => handleRemoteOpenApp('com.instagram.android')}
                    disabled={remoteActionLoading}
                  >
                    📸 Instagram
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10"
                    onClick={() => handleRemoteOpenApp('com.zhiliaoapp.musically')}
                    disabled={remoteActionLoading}
                  >
                    🎵 TikTok
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px]"
                    onClick={() => handleRemoteOpenApp('com.android.settings')}
                    disabled={remoteActionLoading}
                  >
                    ⚙️ Настройки
                  </Button>
                </div>
              </div>

              {/* 5. Stream Controls Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-surface-3/50 rounded-xl border border-border/60">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={refreshRemoteFrame}
                    loading={remoteScreenLoading}
                    className="text-xs"
                  >
                    🔄 Обновить кадр
                  </Button>
                  <Button
                    size="sm"
                    variant={remoteLive ? "secondary" : "outline"}
                    onClick={() => setRemoteLive(!remoteLive)}
                    className="text-xs"
                  >
                    {remoteLive ? "⏸ Пауза потока" : "▶ Включить Live"}
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRemoteModalOpen(false);
                    setRemoteScreenData(null);
                  }}
                >
                  Закрыть пульт
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Screenshot Preview Modal */}
      {screenshotModalOpen && selectedDevice && (
        <Modal
          title={`📸 Экран платы: ${selectedDevice.name} (${selectedDevice.deviceId})`}
          onClose={() => {
            setScreenshotModalOpen(false);
            setScreenshotData(null);
          }}
        >
          <div className="space-y-4">
            {screenshotLoading ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <LoadingSpinner size={32} />
                <p className="text-xs text-text-secondary">Захват экрана через ADB...</p>
              </div>
            ) : (
              renderScreenshotPreview(screenshotData)
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  loading={screenshotLoading}
                  onClick={() => handleScreenshot(selectedDevice)}
                >
                  🔄 Обновить снимок
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleWake(selectedDevice.deviceId)}
                >
                  💡 Разбудить
                </Button>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setScreenshotModalOpen(false);
                  setScreenshotData(null);
                }}
              >
                Закрыть
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Health & Auto-Heal Diagnostics Modal */}
      {healthModalOpen && selectedDevice && (
        <Modal
          title={`🩺 Диагностика: ${selectedDevice.name}`}
          onClose={() => {
            setHealthModalOpen(false);
            setHealthData(null);
          }}
        >
          <div className="space-y-4 text-xs">
            {healthLoading ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <LoadingSpinner size={32} />
                <p className="text-xs text-text-secondary">Опрос телеметрии Android платы...</p>
              </div>
            ) : healthData ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg bg-surface-2 border border-border space-y-1">
                    <span className="text-[11px] text-text-tertiary">Статус платы:</span>
                    <div className="flex items-center gap-2">
                      <span className={cn("w-2 h-2 rounded-full", healthData.online ? "bg-emerald-500" : "bg-rose-500")} />
                      <span className="font-semibold text-text-primary">
                        {healthData.online ? "Онлайн (ADB готов)" : "Оффлайн"}
                      </span>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-surface-2 border border-border space-y-1">
                    <span className="text-[11px] text-text-tertiary">Питание DC-DC стойки:</span>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-text-primary">{healthData.batteryLevel ?? 100}%</span>
                      <Badge variant="outline" className="text-[10px]">DC-DC 4.2V</Badge>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-surface-2 border border-border space-y-1">
                    <span className="text-[11px] text-text-tertiary">Температура платы:</span>
                    <div className="flex items-center justify-between">
                      <span className={cn(
                        "font-semibold text-sm",
                        (healthData.batteryTemp ?? 35) > 45 ? "text-rose-400 font-bold" : "text-emerald-400"
                      )}>
                        {healthData.batteryTemp ?? 35}°C
                      </span>
                      {(healthData.batteryTemp ?? 35) > 45 ? (
                        <Badge variant="danger" className="text-[10px]">⚠️ Нагрев</Badge>
                      ) : (
                        <Badge variant="success" className="text-[10px]">В норме</Badge>
                      )}
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-surface-2 border border-border space-y-1">
                    <span className="text-[11px] text-text-tertiary">Свободная RAM:</span>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-text-primary font-mono">
                        {healthData.freeRamMb ? `${healthData.freeRamMb} MB` : 'Достаточно'}
                      </span>
                      <Badge variant="outline" className="text-[10px]">LPDDR4</Badge>
                    </div>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-surface-3/70 border border-border/60 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-text-primary">Стабилизация и авто-лечение:</span>
                  </div>
                  <p className="text-text-secondary text-[11px]">
                    Сбрасывает зависшие системные оверлеи (ANR «Приложение не отвечает»), активирует режим постоянного бодрствования стойки и снимает блокировку экрана.
                  </p>
                  <Button
                    size="sm"
                    variant="primary"
                    className="w-full bg-indigo-600 hover:bg-indigo-500"
                    loading={healing}
                    onClick={() => handleHealBoard(selectedDevice.deviceId)}
                  >
                    🩺 Стабилизировать плату (Heal)
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-rose-400 text-center py-6">Не удалось получить данные телеметрии</p>
            )}

            <div className="flex justify-end pt-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setHealthModalOpen(false);
                  setHealthData(null);
                }}
              >
                Закрыть
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function renderScreenshotPreview(data: any) {
  if (!data) return <p className="text-text-secondary text-center py-12">Нет данных скриншота</p>;

  let src = '';
  if (typeof data === 'string') {
    const s = data.trim();
    if (s.startsWith('data:image') || s.startsWith('http')) {
      src = s;
    } else {
      src = `data:image/png;base64,${s.replace(/\s+/g, '')}`;
    }
  } else if (typeof data === 'object') {
    const raw = data.data || data.comm?.data || data.base64 || data.image || data.img || data.result || data.url;
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (s.startsWith('data:image') || s.startsWith('http')) {
        src = s;
      } else {
        src = `data:image/png;base64,${s.replace(/\s+/g, '')}`;
      }
    } else if (raw && typeof raw === 'object') {
      const nested = (raw as any).data || (raw as any).image || (raw as any).base64;
      if (typeof nested === 'string') {
        const s = nested.trim();
        src = s.startsWith('data:image') || s.startsWith('http') ? s : `data:image/png;base64,${s.replace(/\s+/g, '')}`;
      }
    }
  }

  if (src) {
    return (
      <div className="flex flex-col items-center justify-center p-3 bg-zinc-950/80 rounded-xl border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt="Скриншот экрана платы"
          className="max-h-[480px] w-auto rounded-lg shadow-2xl border border-border/80 object-contain"
        />
      </div>
    );
  }

  return (
    <div className="p-4 bg-surface-2 rounded-lg text-xs font-mono break-all max-h-60 overflow-y-auto">
      <p className="text-text-tertiary mb-2">Ответ Device Agent (ADB):</p>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}


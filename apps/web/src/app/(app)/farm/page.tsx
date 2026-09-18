"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type FarmScriptPreset,
  type CustomFarmScript,
  type FlowStep,
  type RunScriptBatchResult,
  type FarmSchedule,
  type FarmScheduleRunLog,
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

const APK_PRESETS = [
  {
    id: 'autox',
    name: 'AutoX.js v6.6.3',
    packageName: 'org.autojs.autoxjs.v6',
    category: 'Автоматизация действий',
    description: 'Нативный движок JavaScript для автоматизации тапов, скролла, заполнения форм и сценариев прогрева',
    url: 'https://github.com/kkevsekk1/AutoX/releases/download/v6.6.3/AutoX-v6.6.3-universal.apk',
    icon: '⚡',
    recommended: true,
  },
  {
    id: 'wb',
    name: 'Wildberries Client',
    packageName: 'com.wildberries.ru',
    category: 'E-Commerce / Маркетплейс',
    description: 'Официальный мобильный клиент WB для поведенческого прогрева товаров, свайпа фото и отзывов',
    url: 'https://s.apkpure.net/dl?id=com.wildberries.ru',
    icon: '🛍️',
  },
  {
    id: 'instagram',
    name: 'Instagram Lite / Official',
    packageName: 'com.instagram.android',
    category: 'Социальные сети',
    description: 'Официальное приложение Instagram для органических публикаций Reels и прогрева аккаунтов',
    url: 'https://s.apkpure.net/dl?id=com.instagram.android',
    icon: '📸',
  },
  {
    id: 'tiktok',
    name: 'TikTok Official',
    packageName: 'com.zhiliaoapp.musically',
    category: 'Социальные сети',
    description: 'Официальный клиент TikTok для постинга и нативного удержания аудитории',
    url: 'https://s.apkpure.net/dl?id=com.zhiliaoapp.musically',
    icon: '🎵',
  },
  {
    id: 'proxydroid',
    name: 'ProxyDroid',
    packageName: 'net.bldv.proxydroid',
    category: 'Сетевой менеджмент',
    description: 'Системный SOCKS5/HTTP роутер для изоляции сетевых соединений каждой платы через отдельный IP',
    url: 'https://github.com/madeye/proxydroid/releases/download/v3.1.0/ProxyDroid-3.1.0.apk',
    icon: '🛡️',
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    packageName: 'com.android.chrome',
    category: 'Браузер',
    description: 'Браузер для тестирования веб-сайтов, проверки IP (2ip / whoer) и авторизаций',
    url: 'https://s.apkpure.net/dl?id=com.android.chrome',
    icon: '🌐',
  },
];

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
  const [remoteFps, setRemoteFps] = useState<number>(250);
  const [remoteScreenData, setRemoteScreenData] = useState<string | null>(null);
  const [remoteScreenLoading, setRemoteScreenLoading] = useState(false);
  const [remoteActionLoading, setRemoteActionLoading] = useState(false);
  const [remoteTouchRipple, setRemoteTouchRipple] = useState<{ x: number; y: number } | null>(null);
  const [remoteTextInput, setRemoteTextInput] = useState('');
  const [masterSlaveEnabled, setMasterSlaveEnabled] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; time: number } | null>(null);

  // Batch APK Installer State
  const [apkModalOpen, setApkModalOpen] = useState(false);
  const [apkSourceType, setApkSourceType] = useState<'preset' | 'upload' | 'url'>('preset');
  const [selectedApkPreset, setSelectedApkPreset] = useState<string>('autox');
  const [customApkUrl, setCustomApkUrl] = useState('');
  const [uploadedApkFile, setUploadedApkFile] = useState<File | null>(null);
  const [apkReinstall, setApkReinstall] = useState(true);
  const [apkGrantPermissions, setApkGrantPermissions] = useState(true);
  const [apkTargetMode, setApkTargetMode] = useState<'all' | 'custom'>('all');
  const [apkSelectedTargets, setApkSelectedTargets] = useState<string[]>([]);
  const [apkInstalling, setApkInstalling] = useState(false);
  const [apkInstallProgressMsg, setApkInstallProgressMsg] = useState<string | null>(null);
  const [apkInstallReport, setApkInstallReport] = useState<any | null>(null);

  // App Manager State
  const [appManagerModalOpen, setAppManagerModalOpen] = useState(false);
  const [appManagerDevice, setAppManagerDevice] = useState<string>('');
  const [appManagerPackages, setAppManagerPackages] = useState<string[]>([]);
  const [appManagerLoading, setAppManagerLoading] = useState(false);
  const [appManagerActionLoading, setAppManagerActionLoading] = useState(false);
  const [appManagerSearch, setAppManagerSearch] = useState('');
  const [appManagerFeedback, setAppManagerFeedback] = useState<string | null>(null);
  const [appManagerTargetAll, setAppManagerTargetAll] = useState(true);

  // ── Automation Studio (Stage 3) State ──────────────────────────────────────
  const [scriptModalOpen, setScriptModalOpen] = useState(false);
  const [scriptActiveTab, setScriptActiveTab] = useState<'presets' | 'flow' | 'autojs' | 'saved'>('presets');
  const [scriptPresets, setScriptPresets] = useState<FarmScriptPreset[]>([]);
  const [customScripts, setCustomScripts] = useState<CustomFarmScript[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<FarmScriptPreset | null>(null);
  const [presetVars, setPresetVars] = useState<Record<string, string>>({});

  // Target boards for script execution
  const [scriptTargetMode, setScriptTargetMode] = useState<'all' | 'custom'>('all');
  const [scriptSelectedTargets, setScriptSelectedTargets] = useState<string[]>([]);

  // Flow builder state
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>([
    { type: 'launch', packageName: 'com.wildberries.ru' },
    { type: 'sleep', durationMs: 3000, jitterMs: 1000 },
    { type: 'random_scroll', count: 3, direction: 'down' },
    { type: 'key', key: 'home' },
  ]);

  // Auto.js code editor state
  const [autoJsCode, setAutoJsCode] = useState<string>(
    `// Скрипт автоматизации AutoX.js для физической платы\nconsole.log("Запуск скрипта на плате: " + device.model);\ntoast("Запуск скрипта KMM Zavod");\n\n// Органический скролл ленты\nfor (let i = 0; i < 3; i++) {\n    scrollDown();\n    sleep(2000 + random(500, 1500));\n}\n\nhome();\ntoast("Сценарий успешно завершен!");`
  );
  const [autoJsScriptName, setAutoJsScriptName] = useState<string>('macro.js');

  // Execution & Live Logs
  const [scriptRunning, setScriptRunning] = useState(false);
  const [scriptProgressMsg, setScriptProgressMsg] = useState<string | null>(null);
  const [scriptBatchResult, setScriptBatchResult] = useState<RunScriptBatchResult | null>(null);
  const [expandedLogBoard, setExpandedLogBoard] = useState<string | null>(null);

  // Custom script saving form
  const [saveScriptName, setSaveScriptName] = useState('');
  const [saveScriptCategory, setSaveScriptCategory] = useState('Пользовательские');
  const [saveScriptDesc, setSaveScriptDesc] = useState('');
  const [saveScriptSuccessMsg, setSaveScriptSuccessMsg] = useState<string | null>(null);

  // ── Task Scheduler (Stage 4) State ─────────────────────────────────────────
  const [schedulerModalOpen, setSchedulerModalOpen] = useState(false);
  const [schedulerTab, setSchedulerTab] = useState<'tasks' | 'new' | 'history'>('tasks');
  const [schedules, setSchedules] = useState<FarmSchedule[]>([]);
  const [schedulerLoading, setSchedulerLoading] = useState(false);
  const [activeHistorySchedule, setActiveHistorySchedule] = useState<FarmSchedule | null>(null);
  const [historyLogs, setHistoryLogs] = useState<FarmScheduleRunLog[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [runningNowId, setRunningNowId] = useState<string | null>(null);
  const [schedulerFeedback, setSchedulerFeedback] = useState<string | null>(null);

  // New Schedule form state
  const [newSchedName, setNewSchedName] = useState('');
  const [newSchedDesc, setNewSchedDesc] = useState('');
  const [newSchedActionType, setNewSchedActionType] = useState<'preset' | 'custom'>('preset');
  const [newSchedPresetId, setNewSchedPresetId] = useState('wb_organic_warmup');
  const [newSchedCustomId, setNewSchedCustomId] = useState('');
  const [newSchedVariables, setNewSchedVariables] = useState<Record<string, string>>({ SKU: '1145510159' });
  const [newSchedTriggerType, setNewSchedTriggerType] = useState<'interval' | 'cron' | 'once'>('interval');
  const [newSchedIntervalMins, setNewSchedIntervalMins] = useState(120);
  const [newSchedCron, setNewSchedCron] = useState('0 10,14,19 * * *');
  const [newSchedRunOnceAt, setNewSchedRunOnceAt] = useState('');
  const [newSchedJitterMins, setNewSchedJitterMins] = useState(10);
  const [newSchedTargetMode, setNewSchedTargetMode] = useState<'all' | 'custom'>('all');
  const [newSchedTargetDeviceIds, setNewSchedTargetDeviceIds] = useState<string[]>([]);
  const [savingSchedule, setSavingSchedule] = useState(false);

  // ── Network Management & Proxy Hub (Stage 5) State ─────────────────────────
  const [networkModalOpen, setNetworkModalOpen] = useState(false);
  const [networkTab, setNetworkTab] = useState<'anti_leak' | 'restart_net' | 'batch_proxy'>('anti_leak');
  const [rotatingDeviceIds, setRotatingDeviceIds] = useState<Record<string, boolean>>({});
  const [restartingNet, setRestartingNet] = useState(false);
  const [restartNetMode, setRestartNetMode] = useState<'ethernet' | 'wifi' | 'all'>('ethernet');
  const [restartTargetDeviceIds, setRestartTargetDeviceIds] = useState<string[]>([]);
  const [restartLogs, setRestartLogs] = useState<Array<{ deviceId: string; mode: string; ok: boolean; log: string }>>([]);
  const [batchProxyText, setBatchProxyText] = useState('');
  const [batchProxyType, setBatchProxyType] = useState<'http' | 'socks5' | 'mobile' | 'residential'>('http');
  const [batchProxyTargets, setBatchProxyTargets] = useState<string[]>([]);
  const [batchProxyApplying, setBatchProxyApplying] = useState(false);
  const [batchCheckingIps, setBatchCheckingIps] = useState(false);
  const [networkFeedbackMsg, setNetworkFeedbackMsg] = useState<string | null>(null);
  const [editingRotateUrl, setEditingRotateUrl] = useState<Record<string, string>>({});

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

  const inFlightFrameRef = useRef(false);
  const remoteImgRef = useRef<HTMLImageElement>(null);
  const deviceResolutionRef = useRef<{ width: number; height: number }>({ width: 1080, height: 2220 });

  const refreshRemoteFrame = useCallback(async () => {
    if (!selectedDevice || inFlightFrameRef.current) return;
    inFlightFrameRef.current = true;
    setRemoteScreenLoading(true);
    try {
      const res = await accountFarmApi.screenshotDevice(selectedDevice.deviceId);
      if (res.ok && res.data) {
        const raw = (res.data as any).data || res.data;
        if (typeof raw === 'string') {
          const s = raw.trim();
          setRemoteScreenData(s.startsWith('data:image') || s.startsWith('http') ? s : `data:image/jpeg;base64,${s}`);
        }
        if (res.data.width && res.data.height) {
          deviceResolutionRef.current = { width: res.data.width, height: res.data.height };
        }
      }
    } catch {
      // silent retry on frame capture
    } finally {
      inFlightFrameRef.current = false;
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

  /** Exact touch coordinate calculation factoring in letterbox/pillarbox bars of object-contain. */
  const getNormalizedCoordinates = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const img = remoteImgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      return {
        xPercent: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        yPercent: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
        rippleX: e.clientX - rect.left,
        rippleY: e.clientY - rect.top,
      };
    }

    const imgAspect = img.naturalWidth / img.naturalHeight;
    const containerAspect = rect.width / rect.height;

    let renderedWidth = rect.width;
    let renderedHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (imgAspect > containerAspect) {
      // Image is wider than container (e.g. landscape mode or wider aspect ratio)
      renderedWidth = rect.width;
      renderedHeight = rect.width / imgAspect;
      offsetX = 0;
      offsetY = (rect.height - renderedHeight) / 2;
    } else {
      // Image is taller than container (standard vertical phone screen)
      renderedHeight = rect.height;
      renderedWidth = rect.height * imgAspect;
      offsetX = (rect.width - renderedWidth) / 2;
      offsetY = 0;
    }

    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const xOnImg = clientX - offsetX;
    const yOnImg = clientY - offsetY;

    const xPercent = Math.max(0, Math.min(1, xOnImg / renderedWidth));
    const yPercent = Math.max(0, Math.min(1, yOnImg / renderedHeight));

    return {
      xPercent,
      yPercent,
      rippleX: clientX,
      rippleY: clientY,
    };
  };

  const handleRemoteMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const { xPercent, yPercent } = getNormalizedCoordinates(e);
    setDragStart({ x: xPercent, y: yPercent, time: Date.now() });
  };

  const handleRemoteMouseUp = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragStart || !selectedDevice) return;
    const { xPercent, yPercent, rippleX, rippleY } = getNormalizedCoordinates(e);

    const deltaX = Math.abs(xPercent - dragStart.x);
    const deltaY = Math.abs(yPercent - dragStart.y);
    const duration = Math.max(100, Math.min(1500, Date.now() - dragStart.time));
    const targets = getTargetDeviceIds();

    setDragStart(null);

    if (deltaX < 0.03 && deltaY < 0.03) {
      setRemoteTouchRipple({ x: rippleX, y: rippleY });
      setTimeout(() => setRemoteTouchRipple(null), 400);

      const targetWidth = deviceResolutionRef.current?.width || 1080;
      const targetHeight = deviceResolutionRef.current?.height || 2220;
      const targetX = Math.round(dragStart.x * targetWidth);
      const targetY = Math.round(dragStart.y * targetHeight);

      try {
        await accountFarmApi.tapDevice(selectedDevice.deviceId, {
          targetX,
          targetY,
          xPercent: dragStart.x,
          yPercent: dragStart.y,
          targetDeviceIds: targets,
        });
        setTimeout(refreshRemoteFrame, 150);
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
        setTimeout(refreshRemoteFrame, 300);
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

  const handleRemoteSetOrientation = async (orientation: 0 | 1) => {
    if (!selectedDevice) return;
    setRemoteActionLoading(true);
    try {
      await accountFarmApi.setDeviceOrientation(selectedDevice.deviceId, orientation, getTargetDeviceIds());
      setTimeout(refreshRemoteFrame, 350);
    } catch (err: any) {
      alert(`Ошибка установки ориентации: ${err.message}`);
    } finally {
      setRemoteActionLoading(false);
    }
  };

  const handleRemoteAcceptDialog = async () => {
    if (!selectedDevice) return;
    setRemoteActionLoading(true);
    try {
      await accountFarmApi.acceptDeviceDialog(selectedDevice.deviceId, getTargetDeviceIds());
      setTimeout(refreshRemoteFrame, 350);
    } catch (err: any) {
      alert(`Ошибка подтверждения диалога: ${err.message}`);
    } finally {
      setRemoteActionLoading(false);
    }
  };

  const handleRemoteGrantPermissions = async () => {
    if (!selectedDevice) return;
    setRemoteActionLoading(true);
    try {
      await accountFarmApi.grantDevicePermissions(selectedDevice.deviceId, undefined, getTargetDeviceIds());
      setTimeout(refreshRemoteFrame, 350);
    } catch (err: any) {
      alert(`Ошибка авто-выдачи разрешений: ${err.message}`);
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

  // ── Batch APK Installer Handlers ──────────────────────────────────────────
  const handleOpenApkModal = () => {
    setApkModalOpen(true);
    setApkInstallReport(null);
    setApkInstallProgressMsg(null);
    setApkSelectedTargets(devices.filter((d) => d.online).map((d) => d.deviceId));
  };

  const handleStartBatchInstall = async () => {
    const targets = apkTargetMode === 'all'
      ? devices.filter((d) => d.online).map((d) => d.deviceId)
      : apkSelectedTargets;

    if (targets.length === 0) {
      alert('Выберите хотя бы одну онлайн-плату для установки');
      return;
    }

    setApkInstalling(true);
    setApkInstallReport(null);

    try {
      let report: any = null;

      if (apkSourceType === 'upload') {
        if (!uploadedApkFile) {
          alert('Выберите .apk файл для загрузки');
          setApkInstalling(false);
          return;
        }
        setApkInstallProgressMsg(`Прямая передача ${uploadedApkFile.name} на ферму и параллельная установка по USB на ${targets.length} плат...`);
        report = await accountFarmApi.uploadAndInstallApk({
          file: uploadedApkFile,
          targetDeviceIds: targets,
          reinstall: apkReinstall,
          grantPermissions: apkGrantPermissions,
        });
      } else {
        let finalApkUrl = '';
        if (apkSourceType === 'preset') {
          const preset = APK_PRESETS.find((p) => p.id === selectedApkPreset);
          if (!preset?.url) {
            alert('Не выбран пресет приложения');
            setApkInstalling(false);
            return;
          }
          finalApkUrl = preset.url;
        } else {
          if (!customApkUrl.trim().startsWith('http')) {
            alert('Введите корректную ссылку на APK (начинающуюся с http:// или https://)');
            setApkInstalling(false);
            return;
          }
          finalApkUrl = customApkUrl.trim();
        }

        setApkInstallProgressMsg(`Скачивание APK на хост-ПК фермы и параллельная установка по USB на ${targets.length} плат...`);
        report = await accountFarmApi.installApk({
          apkUrl: finalApkUrl,
          targetDeviceIds: targets,
          reinstall: apkReinstall,
          grantPermissions: apkGrantPermissions,
        });
      }

      setApkInstallReport(report);
      setApkInstallProgressMsg(null);
    } catch (err: any) {
      alert(`Ошибка пакетной установки: ${err.message}`);
    } finally {
      setApkInstalling(false);
      setApkInstallProgressMsg(null);
    }
  };

  // ── App Manager Handlers ──────────────────────────────────────────────────
  const handleOpenAppManager = async (device?: FarmDevice) => {
    const targetDev = device || devices.find((d) => d.online) || devices[0];
    if (targetDev) {
      setAppManagerDevice(targetDev.deviceId);
      setAppManagerModalOpen(true);
      setAppManagerFeedback(null);
      await handleLoadDeviceApps(targetDev.deviceId);
    } else {
      setAppManagerModalOpen(true);
    }
  };

  const handleLoadDeviceApps = async (deviceId: string) => {
    if (!deviceId) return;
    setAppManagerLoading(true);
    setAppManagerFeedback(null);
    try {
      const res = await accountFarmApi.listDeviceApps(deviceId, true);
      setAppManagerPackages(res.packages || []);
    } catch (err: any) {
      setAppManagerFeedback(`Ошибка сканирования пакетов: ${err.message}`);
    } finally {
      setAppManagerLoading(false);
    }
  };

  const handleRunAppAction = async (action: 'uninstall' | 'clear-data' | 'force-stop' | 'launch', packageName: string) => {
    const actionLabels = {
      'uninstall': 'удалить со всех плат',
      'clear-data': 'очистить данные и сбросить сессии на всех платах',
      'force-stop': 'принудительно остановить на всех платах',
      'launch': 'запустить на всех платах',
    };

    if (action === 'uninstall' && !confirm(`Вы уверены, что хотите ${actionLabels[action]} пакет ${packageName}?`)) {
      return;
    }

    const targets = appManagerTargetAll
      ? devices.filter((d) => d.online).map((d) => d.deviceId)
      : [appManagerDevice];

    setAppManagerActionLoading(true);
    setAppManagerFeedback(null);
    try {
      const res = await accountFarmApi.batchAppAction({
        action,
        packageName,
        targetDeviceIds: targets,
      });

      const succ = res.successful ?? res.results?.filter((r: any) => r.ok).length ?? 0;
      setAppManagerFeedback(`Действие "${action}" успешно выполнено на ${succ} из ${targets.length} плат`);

      if (action === 'uninstall') {
        setTimeout(() => handleLoadDeviceApps(appManagerDevice), 1000);
      }
    } catch (err: any) {
      setAppManagerFeedback(`Сбой выполнения: ${err.message}`);
    } finally {
      setAppManagerActionLoading(false);
    }
  };

  // ── Automation Studio Handlers ────────────────────────────────────────────
  const handleOpenScriptModal = async () => {
    setScriptModalOpen(true);
    setScriptBatchResult(null);
    setScriptProgressMsg(null);
    setSaveScriptSuccessMsg(null);
    setScriptSelectedTargets(devices.filter((d) => d.online).map((d) => d.deviceId));

    try {
      const [presetsRes, customRes] = await Promise.allSettled([
        accountFarmApi.listScriptPresets(),
        accountFarmApi.listCustomScripts(),
      ]);

      if (presetsRes.status === 'fulfilled' && presetsRes.value.ok) {
        setScriptPresets(presetsRes.value.presets);
        if (!selectedPreset && presetsRes.value.presets.length > 0) {
          const first = presetsRes.value.presets[0];
          setSelectedPreset(first);
          const initialVars: Record<string, string> = {};
          first.variables.forEach((v) => {
            initialVars[v.key] = v.defaultValue || '';
          });
          setPresetVars(initialVars);
        }
      }

      if (customRes.status === 'fulfilled' && customRes.value.ok) {
        setCustomScripts(customRes.value.scripts);
      }
    } catch (err: any) {
      console.error('Failed to load scripts data:', err);
    }
  };

  const handleSelectPreset = (preset: FarmScriptPreset) => {
    setSelectedPreset(preset);
    const initialVars: Record<string, string> = {};
    preset.variables.forEach((v) => {
      initialVars[v.key] = v.defaultValue || '';
    });
    setPresetVars(initialVars);
  };

  const getScriptTargets = (): string[] => {
    if (scriptTargetMode === 'all') {
      return devices.filter((d) => d.online).map((d) => d.deviceId);
    }
    return scriptSelectedTargets;
  };

  const handleRunPreset = async () => {
    if (!selectedPreset) return;
    const targets = getScriptTargets();
    if (targets.length === 0) {
      alert('Выберите хотя бы одну онлайн-плату для запуска');
      return;
    }

    setScriptRunning(true);
    setScriptBatchResult(null);
    setScriptProgressMsg(`Запуск пресета "${selectedPreset.name}" на ${targets.length} платах...`);

    try {
      const res = await accountFarmApi.runFarmScript({
        engine: selectedPreset.engine,
        steps: selectedPreset.steps,
        jsCode: selectedPreset.jsCode,
        targetDeviceIds: targets,
        variables: presetVars,
        scriptName: `${selectedPreset.id}.js`,
      });

      setScriptBatchResult(res);
      setScriptProgressMsg(
        `Завершено! Успешно: ${res.successful} из ${res.targetsCount} плат.`
      );
    } catch (err: any) {
      setScriptProgressMsg(`Ошибка выполнения пресета: ${err.message}`);
    } finally {
      setScriptRunning(false);
    }
  };

  const handleRunFlow = async () => {
    const targets = getScriptTargets();
    if (targets.length === 0) {
      alert('Выберите хотя бы одну онлайн-плату для запуска');
      return;
    }
    if (flowSteps.length === 0) {
      alert('Добавьте хотя бы один шаг в конструктор');
      return;
    }

    setScriptRunning(true);
    setScriptBatchResult(null);
    setScriptProgressMsg(`Выполнение цепочки из ${flowSteps.length} шагов на ${targets.length} платах...`);

    try {
      const res = await accountFarmApi.runFarmScript({
        engine: 'adb_flow',
        steps: flowSteps,
        targetDeviceIds: targets,
      });

      setScriptBatchResult(res);
      setScriptProgressMsg(
        `Цепочка завершена! Успешно: ${res.successful} из ${res.targetsCount} плат.`
      );
    } catch (err: any) {
      setScriptProgressMsg(`Ошибка выполнения цепочки: ${err.message}`);
    } finally {
      setScriptRunning(false);
    }
  };

  const handleRunAutoJs = async () => {
    const targets = getScriptTargets();
    if (targets.length === 0) {
      alert('Выберите хотя бы одну онлайн-плату для запуска');
      return;
    }
    if (!autoJsCode.trim()) {
      alert('Введите JavaScript код для выполнения');
      return;
    }

    setScriptRunning(true);
    setScriptBatchResult(null);
    setScriptProgressMsg(`Отправка и запуск AutoX.js скрипта на ${targets.length} платах...`);

    try {
      const res = await accountFarmApi.runFarmScript({
        engine: 'autojs',
        jsCode: autoJsCode,
        scriptName: autoJsScriptName || 'macro.js',
        targetDeviceIds: targets,
      });

      setScriptBatchResult(res);
      setScriptProgressMsg(
        `AutoX.js скрипт запущен! Успешно: ${res.successful} из ${res.targetsCount} плат.`
      );
    } catch (err: any) {
      setScriptProgressMsg(`Ошибка запуска AutoX.js: ${err.message}`);
    } finally {
      setScriptRunning(false);
    }
  };

  const handleSaveFlowAsCustom = async () => {
    if (!saveScriptName.trim()) {
      alert('Введите название для сохранения сценария');
      return;
    }
    try {
      const res = await accountFarmApi.saveCustomScript({
        name: saveScriptName.trim(),
        category: saveScriptCategory || 'Пользовательские',
        description: saveScriptDesc,
        engine: scriptActiveTab === 'autojs' ? 'autojs' : 'adb_flow',
        steps: scriptActiveTab === 'autojs' ? undefined : flowSteps,
        jsCode: scriptActiveTab === 'autojs' ? autoJsCode : undefined,
      });

      setSaveScriptSuccessMsg(`Сценарий "${res.script.name}" успешно сохранен!`);
      setSaveScriptName('');
      setSaveScriptDesc('');
      const updated = await accountFarmApi.listCustomScripts();
      if (updated.ok) setCustomScripts(updated.scripts);
    } catch (err: any) {
      alert(`Ошибка сохранения: ${err.message}`);
    }
  };

  const handleDeleteCustomScript = async (id: string) => {
    if (!confirm('Удалить этот пользовательский сценарий?')) return;
    try {
      await accountFarmApi.deleteCustomScript(id);
      setCustomScripts((prev) => prev.filter((s) => s.id !== id));
    } catch (err: any) {
      alert(`Ошибка удаления: ${err.message}`);
    }
  };

  const handleLoadCustomScript = (script: CustomFarmScript) => {
    if (script.engine === 'autojs') {
      setAutoJsCode(script.jsCode || '');
      setScriptActiveTab('autojs');
    } else {
      if (script.steps && script.steps.length > 0) {
        setFlowSteps(script.steps);
      }
      setScriptActiveTab('flow');
    }
  };

  // ── Task Scheduler (Stage 4) Handlers ─────────────────────────────────────
  const handleOpenSchedulerModal = async () => {
    setSchedulerModalOpen(true);
    setSchedulerFeedback(null);
    setSchedulerLoading(true);
    setNewSchedTargetDeviceIds(devices.filter((d) => d.online).map((d) => d.deviceId));

    try {
      const [schedRes, presetsRes, customRes] = await Promise.allSettled([
        accountFarmApi.listSchedules(),
        accountFarmApi.listScriptPresets(),
        accountFarmApi.listCustomScripts(),
      ]);

      if (schedRes.status === 'fulfilled' && schedRes.value.ok) {
        setSchedules(schedRes.value.schedules);
      }
      if (presetsRes.status === 'fulfilled' && presetsRes.value.ok) {
        setScriptPresets(presetsRes.value.presets);
      }
      if (customRes.status === 'fulfilled' && customRes.value.ok) {
        setCustomScripts(customRes.value.scripts);
      }
    } catch (err: any) {
      console.error('Failed to load scheduler data:', err);
    } finally {
      setSchedulerLoading(false);
    }
  };

  const handleToggleSchedule = async (id: string, currentState: boolean) => {
    try {
      const res = await accountFarmApi.toggleSchedule(id, !currentState);
      if (res.ok) {
        setSchedules((prev) =>
          prev.map((s) => (s.id === id ? res.schedule : s))
        );
      }
    } catch (err: any) {
      alert(`Ошибка изменения статуса: ${err.message}`);
    }
  };

  const handleRunScheduleNow = async (schedule: FarmSchedule) => {
    setRunningNowId(schedule.id);
    setSchedulerFeedback(`Выполнение задачи "${schedule.name}" на физических платах...`);
    try {
      const res = await accountFarmApi.runScheduleNow(schedule.id);
      if (res.ok) {
        setSchedulerFeedback(
          `Задача выполнена! Успешно: ${res.log.successful} из ${res.log.targetsCount} плат (${(res.log.durationMs / 1000).toFixed(1)}с)`
        );
        // Refresh schedules
        const updated = await accountFarmApi.listSchedules();
        if (updated.ok) setSchedules(updated.schedules);
      } else {
        setSchedulerFeedback(`Сбой выполнения: ${res.log?.error || 'Ошибка исполнения на платах'}`);
      }
    } catch (err: any) {
      setSchedulerFeedback(`Ошибка запуска: ${err.message}`);
    } finally {
      setRunningNowId(null);
    }
  };

  const handleDeleteSchedule = async (id: string) => {
    if (!confirm('Удалить эту задачу из планировщика?')) return;
    try {
      await accountFarmApi.deleteSchedule(id);
      setSchedules((prev) => prev.filter((s) => s.id !== id));
    } catch (err: any) {
      alert(`Ошибка удаления: ${err.message}`);
    }
  };

  const handleViewScheduleHistory = async (schedule: FarmSchedule) => {
    setActiveHistorySchedule(schedule);
    setSchedulerTab('history');
    setHistoryLoading(true);
    try {
      const res = await accountFarmApi.getScheduleHistory(schedule.id);
      if (res.ok) setHistoryLogs(res.history);
    } catch (err: any) {
      alert(`Ошибка получения истории: ${err.message}`);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleCreateSchedule = async () => {
    if (!newSchedName.trim()) {
      alert('Укажите название задачи');
      return;
    }

    const targets = newSchedTargetMode === 'all'
      ? devices.filter((d) => d.online).map((d) => d.deviceId)
      : newSchedTargetDeviceIds;

    if (targets.length === 0) {
      alert('Выберите хотя бы одну целевую плату');
      return;
    }

    setSavingSchedule(true);
    try {
      let engine: 'adb_flow' | 'autojs' = 'adb_flow';
      let steps: any[] | undefined;
      let jsCode: string | undefined;

      if (newSchedActionType === 'preset') {
        const p = scriptPresets.find((pr) => pr.id === newSchedPresetId);
        if (p) {
          engine = p.engine;
          steps = p.steps;
          jsCode = p.jsCode;
        }
      } else {
        const c = customScripts.find((cs) => cs.id === newSchedCustomId);
        if (c) {
          engine = c.engine;
          steps = c.steps;
          jsCode = c.jsCode;
        }
      }

      const res = await accountFarmApi.saveSchedule({
        name: newSchedName.trim(),
        description: newSchedDesc.trim() || undefined,
        isActive: true,
        triggerType: newSchedTriggerType,
        intervalMinutes: newSchedTriggerType === 'interval' ? newSchedIntervalMins : undefined,
        cronExpression: newSchedTriggerType === 'cron' ? newSchedCron : undefined,
        runOnceAt: newSchedTriggerType === 'once' ? newSchedRunOnceAt : undefined,
        jitterMinutes: newSchedJitterMins,
        engine,
        presetId: newSchedActionType === 'preset' ? newSchedPresetId : undefined,
        steps,
        jsCode,
        variables: newSchedVariables,
        targetMode: newSchedTargetMode,
        targetDeviceIds: targets,
      });

      if (res.ok) {
        setSchedules((prev) => [res.schedule, ...prev]);
        setSchedulerTab('tasks');
        setSchedulerFeedback(`Задача "${res.schedule.name}" успешно поставлена на расписание!`);
        // Reset form
        setNewSchedName('');
        setNewSchedDesc('');
      }
    } catch (err: any) {
      alert(`Ошибка создания задачи: ${err.message}`);
    } finally {
      setSavingSchedule(false);
    }
  };

  // ── Network Management & Proxy Hub Handlers ────────────────────────────────
  const handleOpenNetworkModal = () => {
    setNetworkModalOpen(true);
    setNetworkFeedbackMsg(null);
    if (restartTargetDeviceIds.length === 0) {
      setRestartTargetDeviceIds(devices.map((d) => d.deviceId));
    }
    if (batchProxyTargets.length === 0) {
      setBatchProxyTargets(devices.map((d) => d.deviceId));
    }
    const initialRotateUrls: Record<string, string> = {};
    devices.forEach((d) => {
      if (d.proxy?.rotateUrl) {
        initialRotateUrls[d.deviceId] = d.proxy.rotateUrl;
      }
    });
    setEditingRotateUrl(initialRotateUrls);
  };

  const handleRotateIp = async (deviceId: string, overrideUrl?: string) => {
    setRotatingDeviceIds((prev) => ({ ...prev, [deviceId]: true }));
    setNetworkFeedbackMsg(null);
    try {
      const targetUrl = overrideUrl || editingRotateUrl[deviceId];
      const res = await accountFarmApi.rotateDeviceProxyIp(deviceId, { rotateUrl: targetUrl });
      if (res.ok) {
        setIpResults((prev) => ({ ...prev, [deviceId]: res.check }));
        setNetworkFeedbackMsg(`Плата ${deviceId}: IP успешно сменен! Новый IP: ${res.check.ip || 'OK'}`);
      } else {
        alert(`Ошибка ротации IP на плате ${deviceId}: ${res.error || 'Неизвестная ошибка'}`);
      }
    } catch (err: any) {
      alert(`Ошибка ротации IP: ${err.message}`);
    } finally {
      setRotatingDeviceIds((prev) => ({ ...prev, [deviceId]: false }));
    }
  };

  const handleBatchRotateIp = async () => {
    const targets = devices.filter((d) => d.online && (d.proxy?.rotateUrl || editingRotateUrl[d.deviceId]));
    if (targets.length === 0) {
      alert('Нет плат с настроенной ссылкой (Webhook) ротации');
      return;
    }
    setNetworkFeedbackMsg(`Запущена одновременная ротация IP на ${targets.length} платах...`);
    await Promise.allSettled(targets.map((d) => handleRotateIp(d.deviceId, editingRotateUrl[d.deviceId])));
  };

  const handleBatchCheckIps = async () => {
    const ids = devices.map((d) => d.deviceId);
    if (ids.length === 0) return;
    setBatchCheckingIps(true);
    setNetworkFeedbackMsg('Проверка IP и Anti-Leak на всех 20 платах...');
    try {
      const res = await accountFarmApi.batchCheckDeviceIps(ids);
      if (res.ok && Array.isArray(res.results)) {
        const nextResults: Record<string, DeviceIpCheck> = {};
        res.results.forEach((item) => {
          nextResults[item.deviceId] = item;
        });
        setIpResults((prev) => ({ ...prev, ...nextResults }));
        const leaks = res.results.filter((r) => r.leakDetected).length;
        setNetworkFeedbackMsg(
          leaks > 0
            ? `⚠️ Проверка завершена! Обнаружено ${leaks} плат с утечкой прямого IP!`
            : `✓ Все ${res.results.length} плат проверены. Утечек прямого IP не обнаружено.`
        );
      }
    } catch (err: any) {
      alert(`Ошибка проверки IP: ${err.message}`);
    } finally {
      setBatchCheckingIps(false);
    }
  };

  const handleRestartNetwork = async () => {
    if (restartTargetDeviceIds.length === 0) {
      alert('Выберите хотя бы одну плату для перезапуска');
      return;
    }
    setRestartingNet(true);
    setNetworkFeedbackMsg(`Перезапуск сетевых интерфейсов (${restartNetMode}) на ${restartTargetDeviceIds.length} платах...`);
    try {
      const res = await accountFarmApi.restartDeviceNetwork({
        mode: restartNetMode,
        targetDeviceIds: restartTargetDeviceIds,
      });
      if (res.ok) {
        setRestartLogs(res.results);
        setNetworkFeedbackMsg(`Сетевой стек успешно перезапущен на ${res.successful} платах, сброшен DNS и маршруты!`);
      } else {
        alert(`Ошибка перезапуска сети: ${res.failed} плат не ответили`);
      }
    } catch (err: any) {
      alert(`Ошибка перезапуска сети: ${err.message}`);
    } finally {
      setRestartingNet(false);
    }
  };

  const parseBatchProxyLines = (text: string) => {
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'));
    const parsed: Array<{ host: string; port: number; username?: string; password?: string; rotateUrl?: string }> = [];

    for (const line of lines) {
      let mainPart = line;
      let rotUrl: string | undefined;
      if (line.includes('|')) {
        const parts = line.split('|');
        mainPart = parts[0].trim();
        rotUrl = parts[1].trim();
      }

      if (mainPart.startsWith('http://') || mainPart.startsWith('https://') || mainPart.startsWith('socks5://')) {
        try {
          const u = new URL(mainPart);
          parsed.push({
            host: u.hostname,
            port: Number(u.port) || 8080,
            username: u.username || undefined,
            password: u.password || undefined,
            rotateUrl: rotUrl,
          });
          continue;
        } catch {
          // fallback to tokens
        }
      }

      const tokens = mainPart.split(':');
      if (tokens.length >= 2) {
        const host = tokens[0].trim();
        const port = Number(tokens[1].trim());
        const username = tokens[2]?.trim() || undefined;
        const password = tokens[3]?.trim() || undefined;
        const potentialUrl = tokens.slice(4).join(':').trim() || rotUrl;

        if (host && !isNaN(port)) {
          parsed.push({
            host,
            port,
            username,
            password,
            rotateUrl: potentialUrl && potentialUrl.startsWith('http') ? potentialUrl : undefined,
          });
        }
      }
    }
    return parsed;
  };

  const handleApplyBatchProxies = async () => {
    const parsed = parseBatchProxyLines(batchProxyText);
    if (parsed.length === 0) {
      alert('Не удалось распознать ни одного прокси в введенном тексте');
      return;
    }
    if (batchProxyTargets.length === 0) {
      alert('Выберите целевые платы для распределения');
      return;
    }

    const assignments = batchProxyTargets.slice(0, parsed.length).map((devId, idx) => ({
      deviceId: devId,
      host: parsed[idx].host,
      port: parsed[idx].port,
      username: parsed[idx].username,
      password: parsed[idx].password,
      type: batchProxyType,
      rotateUrl: parsed[idx].rotateUrl,
    }));

    if (assignments.length === 0) {
      alert('Нет совпадений между списком прокси и выбранными платами');
      return;
    }

    setBatchProxyApplying(true);
    setNetworkFeedbackMsg(`Назначение прокси 1-к-1 на ${assignments.length} плат...`);
    try {
      const res = await accountFarmApi.batchSetDeviceProxies(assignments);
      if (res.ok) {
        setNetworkFeedbackMsg(`Прокси успешно применены к ${res.successful} платам! Запускается перепроверка IP...`);
        setDevices((prev) =>
          prev.map((d) => {
            const match = assignments.find((a) => a.deviceId === d.deviceId);
            if (match) {
              return {
                ...d,
                proxy: {
                  host: match.host,
                  port: match.port,
                  type: match.type,
                  rotateUrl: match.rotateUrl,
                },
              };
            }
            return d;
          })
        );
        await handleBatchCheckIps();
      } else {
        alert(`Ошибка пакетного применения: ${res.failed} плат завершились с ошибкой`);
      }
    } catch (err: any) {
      alert(`Ошибка применения прокси: ${err.message}`);
    } finally {
      setBatchProxyApplying(false);
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
          <Button
            size="sm"
            variant="primary"
            className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1.5 shadow-sm"
            onClick={handleOpenApkModal}
          >
            📦 Пакетная установка APK
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10 flex items-center gap-1.5"
            onClick={() => handleOpenAppManager()}
          >
            📱 Менеджер приложений
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="bg-amber-600 hover:bg-amber-500 text-white font-semibold flex items-center gap-1.5 shadow-sm"
            onClick={handleOpenScriptModal}
          >
            🤖 Сценарии и Автоматизация
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="bg-blue-600 hover:bg-blue-500 text-white font-semibold flex items-center gap-1.5 shadow-sm"
            onClick={handleOpenSchedulerModal}
          >
            ⏱️ Планировщик и Автопилот
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="bg-cyan-600 hover:bg-cyan-500 text-white font-semibold flex items-center gap-1.5 shadow-sm"
            onClick={handleOpenNetworkModal}
          >
            🌐 Сеть и Прокси (Network Hub)
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
                    variant="outline"
                    className="text-[11px] py-1 h-auto text-indigo-300 border-indigo-500/30 hover:bg-indigo-500/10"
                    onClick={() => handleOpenAppManager(device)}
                  >
                    📱 Прил.
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
                      ref={remoteImgRef}
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
                <div className="w-full pt-2 flex items-center justify-around px-2 gap-1.5 z-10">
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
                  <button
                    onClick={handleRemoteAcceptDialog}
                    disabled={remoteActionLoading}
                    title="Подтвердить диалог / Enter (OK)"
                    className="flex-1 py-1.5 flex items-center justify-center rounded-lg bg-emerald-800 hover:bg-emerald-700 active:scale-95 text-emerald-100 hover:text-white transition-all text-[11px] font-bold"
                  >
                    ↵ OK
                  </button>
                  <button
                    onClick={() => handleRemoteSetOrientation(0)}
                    disabled={remoteActionLoading}
                    title="Вернуть в вертикальный портрет (0°)"
                    className="flex-1 py-1.5 flex items-center justify-center rounded-lg bg-blue-800 hover:bg-blue-700 active:scale-95 text-blue-100 hover:text-white transition-all text-[11px] font-bold"
                  >
                    📱 0°
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

              {/* 5. Orientation & Permission Overrides (Fix for landscape & dialog bugs) */}
              <div className="p-3.5 rounded-xl border border-border bg-surface-2 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-text-primary">
                    🛡️ Экран и Права доступа (Решение проблем с диалогами)
                  </label>
                  <span className="text-[10px] text-emerald-400 font-medium">Bypass Tapjacking</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] border-blue-500/40 text-blue-400 hover:bg-blue-500/10"
                    onClick={() => handleRemoteSetOrientation(0)}
                    disabled={remoteActionLoading}
                    title="Принудительно вернуть экран платы в вертикальный режим 0°"
                  >
                    📱 Портрет (0°)
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] border-blue-500/40 text-blue-400 hover:bg-blue-500/10"
                    onClick={() => handleRemoteSetOrientation(1)}
                    disabled={remoteActionLoading}
                    title="Повернуть экран в горизонтальный режим 90°"
                  >
                    🔄 Альбом (90°)
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={handleRemoteAcceptDialog}
                    disabled={remoteActionLoading}
                    title="Нажать кнопку Разрешить на системном диалоге через аппаратный D-Pad"
                  >
                    ✅ Принять права
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                    onClick={handleRemoteGrantPermissions}
                    disabled={remoteActionLoading}
                    title="Выдать активному приложению все права напрямую через ADB pm grant"
                  >
                    🛡️ Auto-Grant
                  </Button>
                </div>
                <p className="text-[10px] text-text-tertiary">
                  Если приложение перевернуло экран — нажмите «📱 Портрет». Если всплыло системное окно «Подтвердить права» и кнопки не нажимаются мышь — нажмите «✅ Принять права» или «🛡️ Auto-Grant».
                </p>
              </div>

              {/* 6. Stream Controls Toolbar */}
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

      {/* ── Batch APK Installer Modal ─────────────────────────────── */}
      {apkModalOpen && (
        <Modal
          title="📦 Пакетная установка APK на стойку плат"
          maxWidth="max-w-3xl"
          onClose={() => {
            if (!apkInstalling) {
              setApkModalOpen(false);
              setApkInstallProgressMsg(null);
            }
          }}
        >
          <div className="space-y-5 text-xs">
            {/* Source tabs: Presets vs File Upload vs Direct URL */}
            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
                1. Выберите источник приложения
              </label>
              <div className="grid grid-cols-3 gap-2 p-1 bg-surface-2 rounded-xl border border-border">
                <button
                  type="button"
                  onClick={() => setApkSourceType('preset')}
                  className={cn(
                    "py-2 px-3 rounded-lg text-xs font-medium transition-all text-center flex items-center justify-center gap-1.5",
                    apkSourceType === 'preset'
                      ? "bg-brand-600 text-white shadow"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                  )}
                >
                  ⚡ Проверенные пресеты
                </button>
                <button
                  type="button"
                  onClick={() => setApkSourceType('upload')}
                  className={cn(
                    "py-2 px-3 rounded-lg text-xs font-medium transition-all text-center flex items-center justify-center gap-1.5",
                    apkSourceType === 'upload'
                      ? "bg-brand-600 text-white shadow"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                  )}
                >
                  📁 Загрузить файл .apk
                </button>
                <button
                  type="button"
                  onClick={() => setApkSourceType('url')}
                  className={cn(
                    "py-2 px-3 rounded-lg text-xs font-medium transition-all text-center flex items-center justify-center gap-1.5",
                    apkSourceType === 'url'
                      ? "bg-brand-600 text-white shadow"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                  )}
                >
                  🔗 Прямая ссылка (URL)
                </button>
              </div>
            </div>

            {/* TAB CONTENT */}
            {apkSourceType === 'preset' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[220px] overflow-y-auto p-1 pr-2">
                {APK_PRESETS.map((preset) => {
                  const isSelected = selectedApkPreset === preset.id;
                  return (
                    <div
                      key={preset.id}
                      onClick={() => setSelectedApkPreset(preset.id)}
                      className={cn(
                        "p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-3",
                        isSelected
                          ? "bg-brand-500/15 border-brand-500 ring-1 ring-brand-500"
                          : "bg-surface-2 border-border hover:border-border/80 hover:bg-surface-3"
                      )}
                    >
                      <span className="text-2xl">{preset.icon}</span>
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-bold text-text-primary text-xs truncate">{preset.name}</span>
                          {preset.recommended && (
                            <Badge variant="success" className="text-[9px] px-1 py-0">★ Топ</Badge>
                          )}
                        </div>
                        <p className="text-[10px] text-brand-400 font-mono truncate">{preset.packageName}</p>
                        <p className="text-[10px] text-text-tertiary line-clamp-2">{preset.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {apkSourceType === 'upload' && (
              <div className="space-y-2">
                <div
                  className={cn(
                    "p-6 rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 text-center cursor-pointer transition-all",
                    uploadedApkFile
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                      : "border-border hover:border-brand-500/50 hover:bg-surface-2/60 text-text-secondary"
                  )}
                  onClick={() => document.getElementById('apk-file-input')?.click()}
                >
                  <input
                    id="apk-file-input"
                    type="file"
                    accept=".apk,application/vnd.android.package-archive"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.[0]) setUploadedApkFile(e.target.files[0]);
                    }}
                  />
                  <span className="text-3xl">📦</span>
                  {uploadedApkFile ? (
                    <div>
                      <p className="font-bold text-sm text-text-primary">{uploadedApkFile.name}</p>
                      <p className="text-xs text-emerald-400">
                        {(uploadedApkFile.size / (1024 * 1024)).toFixed(1)} MB • Готов к отправке
                      </p>
                    </div>
                  ) : (
                    <div>
                      <p className="font-semibold text-text-primary">Нажмите для выбора .apk файла</p>
                      <p className="text-[11px] text-text-tertiary">Поддерживаются любые Android APK (до 500 МБ)</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {apkSourceType === 'url' && (
              <div className="space-y-1.5">
                <label className="text-text-secondary text-xs">Прямая ссылка на скачивание APK</label>
                <Input
                  placeholder="https://.../application.apk"
                  value={customApkUrl}
                  onChange={(e) => setCustomApkUrl(e.target.value)}
                  className="font-mono text-xs"
                />
                <p className="text-[10px] text-text-tertiary">
                  Хост-ПК фермы скачает файл по ссылке один раз и мгновенно раздаст на все платы по USB.
                </p>
              </div>
            )}

            {/* Target devices selector */}
            <div className="space-y-2 pt-2 border-t border-border">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
                  2. Целевые платы стойки
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setApkTargetMode('all')}
                    className={cn(
                      "px-2.5 py-1 rounded text-[11px] font-medium transition-all",
                      apkTargetMode === 'all'
                        ? "bg-brand-500/20 text-brand-400 border border-brand-500/40"
                        : "bg-surface-2 text-text-secondary hover:text-text-primary"
                    )}
                  >
                    Все онлайн ({devices.filter((d) => d.online).length} шт)
                  </button>
                  <button
                    type="button"
                    onClick={() => setApkTargetMode('custom')}
                    className={cn(
                      "px-2.5 py-1 rounded text-[11px] font-medium transition-all",
                      apkTargetMode === 'custom'
                        ? "bg-brand-500/20 text-brand-400 border border-brand-500/40"
                        : "bg-surface-2 text-text-secondary hover:text-text-primary"
                    )}
                  >
                    Выбрать платы
                  </button>
                </div>
              </div>

              {apkTargetMode === 'custom' && (
                <div className="grid grid-cols-4 sm:grid-cols-5 gap-1.5 max-h-[110px] overflow-y-auto p-2 bg-surface-2 rounded-xl border border-border">
                  {devices.map((d, i) => {
                    const checked = apkSelectedTargets.includes(d.deviceId);
                    return (
                      <label
                        key={d.deviceId}
                        className={cn(
                          "flex items-center gap-1.5 p-1.5 rounded cursor-pointer text-[10px] select-none border transition-all",
                          checked
                            ? "bg-brand-500/20 border-brand-500/50 text-brand-300 font-semibold"
                            : "bg-surface-3/50 border-border/40 text-text-tertiary"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!d.online}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setApkSelectedTargets((prev) => [...prev, d.deviceId]);
                            } else {
                              setApkSelectedTargets((prev) => prev.filter((id) => id !== d.deviceId));
                            }
                          }}
                          className="rounded border-border"
                        />
                        <span className="truncate">#{i + 1} {d.online ? '' : '(оффлайн)'}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Install flags */}
            <div className="flex flex-wrap items-center gap-4 p-3 bg-surface-2 rounded-xl border border-border">
              <label className="flex items-center gap-2 cursor-pointer text-text-secondary text-xs select-none">
                <input
                  type="checkbox"
                  checked={apkGrantPermissions}
                  onChange={(e) => setApkGrantPermissions(e.target.checked)}
                  className="rounded border-border text-brand-500"
                />
                <span>Автоматически выдать все системные разрешения (<code className="text-brand-400 font-mono">-g</code>)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer text-text-secondary text-xs select-none">
                <input
                  type="checkbox"
                  checked={apkReinstall}
                  onChange={(e) => setApkReinstall(e.target.checked)}
                  className="rounded border-border text-brand-500"
                />
                <span>Переустановить поверх существующей версии (<code className="text-brand-400 font-mono">-r</code>)</span>
              </label>
            </div>

            {/* Progress status notification */}
            {apkInstallProgressMsg && (
              <div className="p-3 bg-brand-500/15 border border-brand-500/40 rounded-xl text-brand-300 flex items-center gap-2.5 animate-pulse">
                <LoadingSpinner size={16} />
                <span className="font-medium">{apkInstallProgressMsg}</span>
              </div>
            )}

            {/* Install Report Results */}
            {apkInstallReport && (
              <div className="space-y-2 p-3 bg-surface-2 rounded-xl border border-border">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-text-primary">Отчет о пакетной установке:</span>
                  <div className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-emerald-400 font-bold">✓ Успешно: {apkInstallReport.successful}</span>
                    <span className="text-text-tertiary">|</span>
                    <span className={apkInstallReport.failed > 0 ? "text-rose-400 font-bold" : "text-text-tertiary"}>
                      ❌ Ошибок: {apkInstallReport.failed}
                    </span>
                    {apkInstallReport.apkSizeMb && (
                      <>
                        <span className="text-text-tertiary">|</span>
                        <span className="text-brand-400">Размер: {apkInstallReport.apkSizeMb} MB</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 max-h-[140px] overflow-y-auto pr-1">
                  {apkInstallReport.results?.map((res: any) => (
                    <div
                      key={res.deviceId}
                      className={cn(
                        "p-2 rounded border text-[10px] space-y-0.5",
                        res.ok ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" : "bg-rose-500/10 border-rose-500/30 text-rose-300"
                      )}
                    >
                      <div className="flex items-center justify-between font-mono">
                        <span className="font-bold truncate">{res.deviceId}</span>
                        <span>{res.ok ? '✓' : '❌'}</span>
                      </div>
                      <p className="text-[9px] text-text-secondary truncate">
                        {res.ok ? `${(res.durationMs / 1000).toFixed(1)} сек` : (res.error || 'Сбой')}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Actions Buttons */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <Button
                size="sm"
                variant="ghost"
                disabled={apkInstalling}
                onClick={() => setApkModalOpen(false)}
              >
                Закрыть
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={apkInstalling}
                onClick={handleStartBatchInstall}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold px-4"
              >
                🚀 Запустить параллельную установку
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── App Manager Modal ─────────────────────────────────────── */}
      {appManagerModalOpen && (
        <Modal
          title="📱 Централизованный менеджер приложений стойки"
          maxWidth="max-w-3xl"
          onClose={() => {
            setAppManagerModalOpen(false);
            setAppManagerFeedback(null);
          }}
        >
          <div className="space-y-4 text-xs">
            {/* Top Toolbar: device picker, search, refresh, target switch */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
              <div className="sm:col-span-4">
                <label className="text-[10px] text-text-tertiary block mb-1">Считать приложения с платы:</label>
                <select
                  value={appManagerDevice}
                  onChange={(e) => {
                    setAppManagerDevice(e.target.value);
                    handleLoadDeviceApps(e.target.value);
                  }}
                  className="w-full bg-surface-2 border border-border rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-brand-500"
                >
                  {devices.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId} disabled={!d.online}>
                      Плата #{i + 1} ({d.deviceId}) {d.online ? '' : '— оффлайн'}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-5">
                <label className="text-[10px] text-text-tertiary block mb-1">Поиск по имени пакета:</label>
                <Input
                  placeholder="Фильтр: wildberries, instagram, tiktok..."
                  value={appManagerSearch}
                  onChange={(e) => setAppManagerSearch(e.target.value)}
                  className="text-xs h-8"
                />
              </div>

              <div className="sm:col-span-3 flex items-end justify-end h-full pt-4">
                <Button
                  size="sm"
                  variant="outline"
                  loading={appManagerLoading}
                  onClick={() => handleLoadDeviceApps(appManagerDevice)}
                  className="w-full h-8 text-xs"
                >
                  🔄 Сканировать
                </Button>
              </div>
            </div>

            {/* Target Scope Switcher */}
            <div className="flex items-center justify-between p-2.5 bg-surface-2 rounded-xl border border-border">
              <div className="flex items-center gap-2">
                <span className="text-text-secondary text-xs">Масштаб применения действий:</span>
                <Badge variant={appManagerTargetAll ? "success" : "default"} className="text-[10px]">
                  {appManagerTargetAll ? `Вся стойка (${devices.filter(d => d.online).length} плат)` : 'Только выбранная плата'}
                </Badge>
              </div>
              <label className="flex items-center gap-2 cursor-pointer text-text-primary text-xs select-none">
                <input
                  type="checkbox"
                  checked={appManagerTargetAll}
                  onChange={(e) => setAppManagerTargetAll(e.target.checked)}
                  className="rounded border-border text-brand-500"
                />
                <span>Дублировать действие на все 20 плат</span>
              </label>
            </div>

            {/* Feedback alert */}
            {appManagerFeedback && (
              <div className="p-2.5 bg-brand-500/10 border border-brand-500/30 rounded-lg text-brand-300 text-xs">
                {appManagerFeedback}
              </div>
            )}

            {/* Packages List */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-text-tertiary px-1">
                <span>Обнаружено сторонних пакетов: {appManagerPackages.length}</span>
                <span>Быстрые действия на платах</span>
              </div>

              {appManagerLoading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2">
                  <LoadingSpinner size={24} />
                  <span className="text-xs text-text-secondary">Считывание списка пакетов через ADB...</span>
                </div>
              ) : appManagerPackages.length === 0 ? (
                <div className="p-8 text-center text-text-secondary bg-surface-2 rounded-xl border border-border">
                  Сторонние приложения не найдены или плата не отвечает
                </div>
              ) : (
                <div className="max-h-[320px] overflow-y-auto space-y-1.5 pr-1">
                  {appManagerPackages
                    .filter((pkg) => !appManagerSearch.trim() || pkg.toLowerCase().includes(appManagerSearch.toLowerCase().trim()))
                    .map((pkg) => (
                      <div
                        key={pkg}
                        className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-surface-2 border border-border hover:border-brand-500/30 transition-all"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-mono text-xs font-semibold text-text-primary truncate">{pkg}</p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px] px-2 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/10"
                            disabled={appManagerActionLoading}
                            onClick={() => handleRunAppAction('launch', pkg)}
                          >
                            🚀 Запуск
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px] px-2 text-amber-400 border-amber-500/40 hover:bg-amber-500/10"
                            disabled={appManagerActionLoading}
                            onClick={() => handleRunAppAction('force-stop', pkg)}
                          >
                            ⏹ Стоп
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px] px-2 text-indigo-300 border-indigo-500/40 hover:bg-indigo-500/10"
                            disabled={appManagerActionLoading}
                            onClick={() => handleRunAppAction('clear-data', pkg)}
                          >
                            🧹 Сброс
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-[11px] px-2 text-rose-400 hover:bg-rose-500/10"
                            disabled={appManagerActionLoading}
                            onClick={() => handleRunAppAction('uninstall', pkg)}
                          >
                            🗑️
                          </Button>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-border">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAppManagerModalOpen(false);
                  setAppManagerFeedback(null);
                }}
              >
                Закрыть
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Automation Studio Modal (Stage 3) ─────────────────────────────────── */}
      {scriptModalOpen && (
        <Modal
          title="🤖 Студия автоматизации и сценариев (Automation Studio)"
          maxWidth="max-w-4xl"
          onClose={() => {
            if (scriptRunning) return;
            setScriptModalOpen(false);
          }}
        >
          <div className="space-y-4">
            {/* Top Engine & Mode Selector Tabs */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
              <div className="flex gap-1.5 p-1 bg-surface-2 rounded-lg border border-border/50">
                <button
                  type="button"
                  onClick={() => setScriptActiveTab('presets')}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                    scriptActiveTab === 'presets'
                      ? "bg-brand-500 text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                  )}
                >
                  <span>⚡ Готовые сценарии</span>
                  <Badge variant="outline" className="text-[10px] px-1 py-0">{scriptPresets.length}</Badge>
                </button>
                <button
                  type="button"
                  onClick={() => setScriptActiveTab('flow')}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                    scriptActiveTab === 'flow'
                      ? "bg-brand-500 text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                  )}
                >
                  <span>🧩 Конструктор шагов (Flow)</span>
                  <Badge variant="outline" className="text-[10px] px-1 py-0">{flowSteps.length}</Badge>
                </button>
                <button
                  type="button"
                  onClick={() => setScriptActiveTab('autojs')}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                    scriptActiveTab === 'autojs'
                      ? "bg-brand-500 text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                  )}
                >
                  <span>💻 Редактор Auto.js (JS)</span>
                  <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1 rounded font-mono">JS</span>
                </button>
                <button
                  type="button"
                  onClick={() => setScriptActiveTab('saved')}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                    scriptActiveTab === 'saved'
                      ? "bg-brand-500 text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                  )}
                >
                  <span>📁 Мои сценарии</span>
                  <Badge variant="outline" className="text-[10px] px-1 py-0">{customScripts.length}</Badge>
                </button>
              </div>

              {/* Target Devices Selection */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-tertiary">Цель:</span>
                <select
                  value={scriptTargetMode}
                  onChange={(e) => setScriptTargetMode(e.target.value as any)}
                  className="bg-surface-2 border border-border rounded-lg text-xs px-2.5 py-1 text-text-primary font-medium focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="all">Вся стойка (20 плат)</option>
                  <option value="custom">Выбранные платы ({scriptSelectedTargets.length})</option>
                </select>
              </div>
            </div>

            {/* Custom Boards Selector (if custom target mode selected) */}
            {scriptTargetMode === 'custom' && (
              <div className="p-3 bg-surface-2/60 rounded-xl border border-border/80 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary font-medium">Выберите целевые платы для запуска:</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-[11px] text-brand-400 hover:underline"
                      onClick={() => setScriptSelectedTargets(devices.filter((d) => d.online).map((d) => d.deviceId))}
                    >
                      Выбрать все онлайн
                    </button>
                    <button
                      type="button"
                      className="text-[11px] text-text-tertiary hover:underline"
                      onClick={() => setScriptSelectedTargets([])}
                    >
                      Снять выбор
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2 max-h-28 overflow-y-auto pr-1">
                  {devices.map((d) => (
                    <label
                      key={d.deviceId}
                      className={cn(
                        "flex items-center gap-1.5 p-1.5 rounded border text-[11px] cursor-pointer font-mono select-none transition-colors",
                        scriptSelectedTargets.includes(d.deviceId)
                          ? "bg-brand-500/15 border-brand-500/50 text-text-primary"
                          : "bg-surface-3/50 border-border text-text-tertiary hover:border-border-hover"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={scriptSelectedTargets.includes(d.deviceId)}
                        disabled={!d.online}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setScriptSelectedTargets((prev) => [...prev, d.deviceId]);
                          } else {
                            setScriptSelectedTargets((prev) => prev.filter((id) => id !== d.deviceId));
                          }
                        }}
                        className="rounded border-border text-brand-500"
                      />
                      <span className="truncate">{d.deviceId}</span>
                      {!d.online && <span className="text-[9px] text-rose-400">offline</span>}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* TAB 1: PRESETS */}
            {scriptActiveTab === 'presets' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {scriptPresets.map((preset) => {
                    const isSelected = selectedPreset?.id === preset.id;
                    return (
                      <div
                        key={preset.id}
                        onClick={() => handleSelectPreset(preset)}
                        className={cn(
                          "p-3.5 rounded-xl border transition-all cursor-pointer space-y-2",
                          isSelected
                            ? "bg-brand-500/10 border-brand-500 shadow-sm ring-1 ring-brand-500/30"
                            : "bg-surface-2 border-border/70 hover:border-border-hover hover:bg-surface-2/80"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="text-xs font-semibold text-text-primary flex items-center gap-1.5">
                            {preset.name}
                          </h4>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] uppercase font-mono px-1.5 py-0.5",
                              preset.engine === 'autojs' ? "border-amber-500/40 text-amber-300" : "border-emerald-500/40 text-emerald-300"
                            )}
                          >
                            {preset.engine === 'autojs' ? 'AutoX.js' : 'Native ADB Flow'}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-text-secondary leading-relaxed">
                          {preset.description}
                        </p>
                        <div className="flex items-center justify-between pt-1 text-[10px] text-text-tertiary">
                          <span>Категория: {preset.category}</span>
                          <span>{preset.steps ? `${preset.steps.length} шагов` : 'JS скрипт'}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Selected Preset Variables & Execution Form */}
                {selectedPreset && (
                  <div className="p-4 bg-surface-2 rounded-xl border border-brand-500/30 space-y-3">
                    <div className="flex items-center justify-between border-b border-border/50 pb-2">
                      <h4 className="text-xs font-semibold text-text-primary flex items-center gap-1.5">
                        <span>Настройки запуска:</span>
                        <span className="text-brand-400">{selectedPreset.name}</span>
                      </h4>
                      <Badge variant="outline" className="text-[10px]">
                        Движок: {selectedPreset.engine}
                      </Badge>
                    </div>

                    {selectedPreset.variables && selectedPreset.variables.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {selectedPreset.variables.map((v) => (
                          <div key={v.key} className="space-y-1">
                            <label className="text-[11px] font-medium text-text-secondary">
                              {v.label} {v.required && <span className="text-rose-400">*</span>}
                            </label>
                            <Input
                              value={presetVars[v.key] ?? v.defaultValue ?? ''}
                              onChange={(e) => setPresetVars((prev) => ({ ...prev, [v.key]: e.target.value }))}
                              placeholder={v.defaultValue || `Значение {{${v.key}}}`}
                              className="text-xs h-8 font-mono bg-surface-1"
                            />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-text-tertiary">Сценарий готов к выполнению без дополнительных параметров.</p>
                    )}

                    <div className="flex items-center justify-between pt-2">
                      <span className="text-[11px] text-text-secondary">
                        Будет запущено на <span className="text-brand-400 font-semibold">{getScriptTargets().length}</span> платах
                      </span>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={scriptRunning}
                        disabled={scriptRunning || getScriptTargets().length === 0}
                        onClick={handleRunPreset}
                        className="bg-brand-600 hover:bg-brand-500 font-semibold text-xs px-4"
                      >
                        ▶ Запустить сценарий
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: FLOW BUILDER */}
            {scriptActiveTab === 'flow' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-semibold text-text-primary">Конструктор цепочки действий (Native ADB Flow)</h4>
                    <p className="text-[11px] text-text-tertiary">Выполняется на физическом уровне Android без необходимости прав рута или фоновых сервисов</p>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-dashed"
                      onClick={() => setFlowSteps((prev) => [...prev, { type: 'sleep', durationMs: 2000, jitterMs: 500 }])}
                    >
                      + Пауза
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-dashed"
                      onClick={() => setFlowSteps((prev) => [...prev, { type: 'random_scroll', count: 2, direction: 'down' }])}
                    >
                      + Скролл
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-dashed"
                      onClick={() => setFlowSteps((prev) => [...prev, { type: 'tap', xPercent: 0.5, yPercent: 0.5 }])}
                    >
                      + Клик (Tap)
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-dashed"
                      onClick={() => setFlowSteps((prev) => [...prev, { type: 'key', key: 'home' }])}
                    >
                      + Кнопка (Key)
                    </Button>
                  </div>
                </div>

                {/* Steps List */}
                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {flowSteps.map((step, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 p-2.5 bg-surface-2 rounded-xl border border-border/80 text-xs hover:border-border-hover transition-colors"
                    >
                      <span className="w-5 h-5 rounded-full bg-surface-3 flex items-center justify-center font-mono font-bold text-[10px] text-text-tertiary shrink-0">
                        {idx + 1}
                      </span>
                      <span className="font-semibold text-brand-400 uppercase text-[10px] w-24 shrink-0 font-mono">
                        {step.type}
                      </span>

                      {/* Step specific editor inline */}
                      <div className="flex-1 flex flex-wrap items-center gap-2 min-w-0">
                        {step.type === 'launch' && (
                          <div className="flex items-center gap-1.5 flex-1">
                            <span className="text-text-tertiary text-[11px]">Пакет:</span>
                            <Input
                              value={step.packageName || ''}
                              onChange={(e) => {
                                const next = [...flowSteps];
                                (next[idx] as any).packageName = e.target.value;
                                setFlowSteps(next);
                              }}
                              className="h-7 text-xs font-mono bg-surface-1 py-1"
                              placeholder="com.wildberries.ru"
                            />
                          </div>
                        )}

                        {step.type === 'sleep' && (
                          <div className="flex items-center gap-2">
                            <span className="text-text-tertiary text-[11px]">Время (мс):</span>
                            <Input
                              type="number"
                              value={step.durationMs || 1000}
                              onChange={(e) => {
                                const next = [...flowSteps];
                                (next[idx] as any).durationMs = parseInt(e.target.value, 10) || 0;
                                setFlowSteps(next);
                              }}
                              className="h-7 text-xs font-mono bg-surface-1 w-24 py-1"
                            />
                            <span className="text-text-tertiary text-[11px]">Джиттер ±:</span>
                            <Input
                              type="number"
                              value={step.jitterMs || 0}
                              onChange={(e) => {
                                const next = [...flowSteps];
                                (next[idx] as any).jitterMs = parseInt(e.target.value, 10) || 0;
                                setFlowSteps(next);
                              }}
                              className="h-7 text-xs font-mono bg-surface-1 w-20 py-1"
                            />
                          </div>
                        )}

                        {step.type === 'tap' && (
                          <div className="flex items-center gap-2">
                            <span className="text-text-tertiary text-[11px]">X%:</span>
                            <Input
                              type="number"
                              step="0.01"
                              value={step.xPercent ?? 0.5}
                              onChange={(e) => {
                                const next = [...flowSteps];
                                (next[idx] as any).xPercent = parseFloat(e.target.value);
                                setFlowSteps(next);
                              }}
                              className="h-7 text-xs font-mono bg-surface-1 w-16 py-1"
                            />
                            <span className="text-text-tertiary text-[11px]">Y%:</span>
                            <Input
                              type="number"
                              step="0.01"
                              value={step.yPercent ?? 0.5}
                              onChange={(e) => {
                                const next = [...flowSteps];
                                (next[idx] as any).yPercent = parseFloat(e.target.value);
                                setFlowSteps(next);
                              }}
                              className="h-7 text-xs font-mono bg-surface-1 w-16 py-1"
                            />
                          </div>
                        )}

                        {step.type === 'random_scroll' && (
                          <div className="flex items-center gap-2">
                            <span className="text-text-tertiary text-[11px]">Повторов:</span>
                            <Input
                              type="number"
                              value={step.count || 3}
                              onChange={(e) => {
                                const next = [...flowSteps];
                                (next[idx] as any).count = parseInt(e.target.value, 10) || 1;
                                setFlowSteps(next);
                              }}
                              className="h-7 text-xs font-mono bg-surface-1 w-16 py-1"
                            />
                            <span className="text-text-tertiary text-[11px]">Направление:</span>
                            <select
                              value={step.direction || 'down'}
                              onChange={(e) => {
                                const next = [...flowSteps];
                                (next[idx] as any).direction = e.target.value as any;
                                setFlowSteps(next);
                              }}
                              className="h-7 text-xs font-mono bg-surface-1 border border-border rounded px-1 text-text-primary"
                            >
                              <option value="down">Вниз (down)</option>
                              <option value="up">Вверх (up)</option>
                            </select>
                          </div>
                        )}

                        {step.type === 'key' && (
                          <div className="flex items-center gap-2">
                            <span className="text-text-tertiary text-[11px]">Кнопка:</span>
                            <select
                              value={String(step.key)}
                              onChange={(e) => {
                                const next = [...flowSteps];
                                (next[idx] as any).key = e.target.value;
                                setFlowSteps(next);
                              }}
                              className="h-7 text-xs font-mono bg-surface-1 border border-border rounded px-2 text-text-primary"
                            >
                              <option value="home">HOME (Домой)</option>
                              <option value="back">BACK (Назад)</option>
                              <option value="recents">RECENTS (Приложения)</option>
                              <option value="power">POWER (Питание)</option>
                              <option value="enter">ENTER</option>
                            </select>
                          </div>
                        )}

                        {step.type === 'text' && (
                          <div className="flex items-center gap-1.5 flex-1">
                            <span className="text-text-tertiary text-[11px]">Текст:</span>
                            <Input
                              value={step.text || ''}
                              onChange={(e) => {
                                const next = [...flowSteps];
                                (next[idx] as any).text = e.target.value;
                                setFlowSteps(next);
                              }}
                              className="h-7 text-xs bg-surface-1 py-1"
                              placeholder="Текст для ввода..."
                            />
                          </div>
                        )}

                        {step.type === 'clear_data' && (
                          <div className="flex items-center gap-1.5 flex-1">
                            <span className="text-text-tertiary text-[11px]">Сброс данных пакета:</span>
                            <Input
                              value={step.packageName || ''}
                              onChange={(e) => {
                                const next = [...flowSteps];
                                (next[idx] as any).packageName = e.target.value;
                                setFlowSteps(next);
                              }}
                              className="h-7 text-xs font-mono bg-surface-1 py-1"
                              placeholder="com.wildberries.ru"
                            />
                          </div>
                        )}
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => {
                            if (idx === 0) return;
                            const next = [...flowSteps];
                            const temp = next[idx - 1];
                            next[idx - 1] = next[idx];
                            next[idx] = temp;
                            setFlowSteps(next);
                          }}
                          className="p-1 text-text-tertiary hover:text-text-primary disabled:opacity-30"
                          title="Выше"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          disabled={idx === flowSteps.length - 1}
                          onClick={() => {
                            if (idx === flowSteps.length - 1) return;
                            const next = [...flowSteps];
                            const temp = next[idx + 1];
                            next[idx + 1] = next[idx];
                            next[idx] = temp;
                            setFlowSteps(next);
                          }}
                          className="p-1 text-text-tertiary hover:text-text-primary disabled:opacity-30"
                          title="Ниже"
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          onClick={() => setFlowSteps((prev) => prev.filter((_, i) => i !== idx))}
                          className="p-1 text-rose-400 hover:text-rose-300"
                          title="Удалить шаг"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Flow Actions */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border">
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const name = prompt('Введите имя сценария для сохранения:', 'Мой сценарий');
                        if (!name) return;
                        setSaveScriptName(name);
                        handleSaveFlowAsCustom();
                      }}
                      className="text-xs"
                    >
                      💾 Сохранить в библиотеку
                    </Button>
                    {saveScriptSuccessMsg && (
                      <span className="text-xs text-emerald-400">{saveScriptSuccessMsg}</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={scriptRunning}
                    disabled={scriptRunning || flowSteps.length === 0 || getScriptTargets().length === 0}
                    onClick={handleRunFlow}
                    className="bg-brand-600 hover:bg-brand-500 font-semibold text-xs px-4"
                  >
                    ▶ Запустить конструктор на {getScriptTargets().length} платах
                  </Button>
                </div>
              </div>
            )}

            {/* TAB 3: AUTO.JS JAVASCRIPT EDITOR */}
            {scriptActiveTab === 'autojs' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-semibold text-text-primary flex items-center gap-1.5">
                      <span>JavaScript редактор скриптов AutoX.js</span>
                      <span className="text-[10px] bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-500/30">
                        Auto.js v6 API
                      </span>
                    </h4>
                    <p className="text-[11px] text-text-tertiary">
                      Полноценная автоматизация с доступом к экрану, координатам, UI селекторам (`id()`, `text()`, `desc()`)
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-text-tertiary font-mono">Файл:</span>
                    <Input
                      value={autoJsScriptName}
                      onChange={(e) => setAutoJsScriptName(e.target.value)}
                      className="h-7 text-xs font-mono bg-surface-1 w-36 py-1"
                      placeholder="script.js"
                    />
                  </div>
                </div>

                {/* Snippets Toolbar */}
                <div className="flex flex-wrap items-center gap-1.5 p-1.5 bg-surface-2 rounded-lg border border-border/70 text-[11px]">
                  <span className="text-text-tertiary px-1">Сниппеты:</span>
                  <button
                    type="button"
                    onClick={() => setAutoJsCode((prev) => prev + `\n// Поиск и клик по тексту\nclick("Войти");\n`)}
                    className="px-2 py-0.5 bg-surface-3 hover:bg-surface-3/80 rounded border border-border text-text-secondary hover:text-text-primary"
                  >
                    + Клик по тексту
                  </button>
                  <button
                    type="button"
                    onClick={() => setAutoJsCode((prev) => prev + `\n// Поиск элемента по id и клик\nid("button_like").findOne().click();\n`)}
                    className="px-2 py-0.5 bg-surface-3 hover:bg-surface-3/80 rounded border border-border text-text-secondary hover:text-text-primary"
                  >
                    + Клик по ID
                  </button>
                  <button
                    type="button"
                    onClick={() => setAutoJsCode((prev) => prev + `\n// Органический скролл вниз\nscrollDown();\nsleep(1800);\n`)}
                    className="px-2 py-0.5 bg-surface-3 hover:bg-surface-3/80 rounded border border-border text-text-secondary hover:text-text-primary"
                  >
                    + Скролл вниз
                  </button>
                  <button
                    type="button"
                    onClick={() => setAutoJsCode((prev) => prev + `\n// Случайная пауза от 2 до 5 сек\nsleep(random(2000, 5000));\n`)}
                    className="px-2 py-0.5 bg-surface-3 hover:bg-surface-3/80 rounded border border-border text-text-secondary hover:text-text-primary"
                  >
                    + Рандомная пауза
                  </button>
                  <button
                    type="button"
                    onClick={() => setAutoJsCode((prev) => prev + `\n// Ввод текста\nsetText("Мой поисковый запрос");\n`)}
                    className="px-2 py-0.5 bg-surface-3 hover:bg-surface-3/80 rounded border border-border text-text-secondary hover:text-text-primary"
                  >
                    + Ввод текста
                  </button>
                </div>

                {/* Code Editor Textarea */}
                <div className="relative rounded-xl border border-border overflow-hidden bg-zinc-950 font-mono text-xs">
                  <Textarea
                    value={autoJsCode}
                    onChange={(e) => setAutoJsCode(e.target.value)}
                    rows={12}
                    className="w-full bg-transparent border-0 text-zinc-100 font-mono text-xs p-4 focus:ring-0 resize-y leading-relaxed"
                    placeholder="// Введите код AutoX.js JavaScript..."
                  />
                </div>

                {/* AutoJs Actions */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border">
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const name = prompt('Введите имя сценария для сохранения:', autoJsScriptName.replace(/\.js$/, ''));
                        if (!name) return;
                        setSaveScriptName(name);
                        handleSaveFlowAsCustom();
                      }}
                      className="text-xs"
                    >
                      💾 Сохранить JS скрипт
                    </Button>
                    {saveScriptSuccessMsg && (
                      <span className="text-xs text-emerald-400">{saveScriptSuccessMsg}</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={scriptRunning}
                    disabled={scriptRunning || !autoJsCode.trim() || getScriptTargets().length === 0}
                    onClick={handleRunAutoJs}
                    className="bg-amber-600 hover:bg-amber-500 font-semibold text-xs px-4 text-white"
                  >
                    ▶ Запустить AutoX.js на {getScriptTargets().length} платах
                  </Button>
                </div>
              </div>
            )}

            {/* TAB 4: SAVED SCRIPTS */}
            {scriptActiveTab === 'saved' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-text-primary">Сохраненные сценарии автоматизации</h4>
                  <span className="text-xs text-text-tertiary">Всего: {customScripts.length}</span>
                </div>

                {customScripts.length === 0 ? (
                  <div className="p-8 text-center text-text-secondary bg-surface-2 rounded-xl border border-border">
                    <p className="text-sm font-medium text-text-primary mb-1">Библиотека пуста</p>
                    <p className="text-xs text-text-tertiary">
                      Создайте и сохраните сценарий во вкладке «Конструктор шагов» или «Редактор Auto.js».
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[350px] overflow-y-auto pr-1">
                    {customScripts.map((script) => (
                      <div
                        key={script.id}
                        className="p-3.5 bg-surface-2 rounded-xl border border-border/80 space-y-2.5 hover:border-border-hover transition-all"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h5 className="text-xs font-semibold text-text-primary">{script.name}</h5>
                            <span className="text-[10px] text-text-tertiary">
                              {script.category} · {relativeTime(script.updatedAt || script.createdAt)}
                            </span>
                          </div>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] font-mono",
                              script.engine === 'autojs' ? "text-amber-300 border-amber-500/40" : "text-brand-300 border-brand-500/40"
                            )}
                          >
                            {script.engine === 'autojs' ? 'AutoX.js' : 'ADB Flow'}
                          </Badge>
                        </div>

                        {script.description && (
                          <p className="text-[11px] text-text-secondary line-clamp-2">
                            {script.description}
                          </p>
                        )}

                        <div className="flex items-center justify-between pt-1 border-t border-border/50">
                          <span className="text-[10px] text-text-tertiary font-mono">
                            {script.steps ? `${script.steps.length} шагов` : `${(script.jsCode || '').length} байт JS`}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-[11px] px-2.5"
                              onClick={() => handleLoadCustomScript(script)}
                            >
                              ✏️ Открыть в редакторе
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-[11px] px-2 text-rose-400 hover:bg-rose-500/10"
                              onClick={() => handleDeleteCustomScript(script.id)}
                            >
                              🗑️
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Live Progress Bar Notification */}
            {scriptProgressMsg && (
              <div className="p-3 bg-brand-500/15 border border-brand-500/40 rounded-xl text-brand-300 flex items-center gap-2.5 animate-pulse">
                <LoadingSpinner size={16} />
                <span className="text-xs font-medium">{scriptProgressMsg}</span>
              </div>
            )}

            {/* Script Execution Report & Step Logs per Device */}
            {scriptBatchResult && (
              <div className="p-4 bg-surface-2 rounded-xl border border-border/80 space-y-3">
                <div className="flex items-center justify-between border-b border-border/60 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">📊</span>
                    <h5 className="text-xs font-semibold text-text-primary">Отчет о выполнении сценария</h5>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={scriptBatchResult.ok ? "success" : "danger"} className="text-[10px]">
                      Успешно: {scriptBatchResult.successful} / {scriptBatchResult.targetsCount}
                    </Badge>
                  </div>
                </div>

                {/* Per-device expandable cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                  {Object.values(scriptBatchResult.devices).map((dev) => {
                    const isExpanded = expandedLogBoard === dev.serial;
                    return (
                      <div
                        key={dev.serial}
                        className={cn(
                          "p-2.5 rounded-lg border text-xs space-y-1.5 transition-all cursor-pointer",
                          dev.ok ? "bg-emerald-500/5 border-emerald-500/30" : "bg-rose-500/5 border-rose-500/30"
                        )}
                        onClick={() => setExpandedLogBoard(isExpanded ? null : dev.serial)}
                      >
                        <div className="flex items-center justify-between font-mono text-[11px]">
                          <span className="font-bold text-text-primary">{dev.serial}</span>
                          <span className={cn("font-semibold", dev.ok ? "text-emerald-400" : "text-rose-400")}>
                            {dev.ok ? `✓ Выполнено (${(dev.totalDurationMs / 1000).toFixed(1)}с)` : '❌ Сбой'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-text-secondary">
                          <span>Шагов: {dev.stepsExecuted} / {dev.totalSteps}</span>
                          <span className="text-brand-400 hover:underline">
                            {isExpanded ? 'Скрыть логи ▲' : 'Логи шагов ▼'}
                          </span>
                        </div>

                        {/* Detailed step logs drawer */}
                        {isExpanded && (
                          <div className="pt-2 border-t border-border/50 space-y-1 font-mono text-[10px] max-h-36 overflow-y-auto">
                            {dev.stepLogs.length === 0 ? (
                              <p className="text-text-tertiary">Логи отсутствуют</p>
                            ) : (
                              dev.stepLogs.map((log) => (
                                <div
                                  key={log.stepIndex}
                                  className={cn(
                                    "flex items-center justify-between p-1 rounded",
                                    log.status === 'success' ? "text-emerald-300 bg-emerald-500/10" : "text-rose-300 bg-rose-500/10"
                                  )}
                                >
                                  <span className="truncate">
                                    {log.status === 'success' ? '✓' : '✕'} #{log.stepIndex} {log.description}
                                  </span>
                                  <span className="shrink-0 ml-1 opacity-70">{log.durationMs}ms</span>
                                </div>
                              ))
                            )}
                            {dev.error && (
                              <p className="text-rose-400 font-sans text-[11px] pt-1">
                                Ошибка: {dev.error}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Bottom Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <Button
                size="sm"
                variant="ghost"
                disabled={scriptRunning}
                onClick={() => setScriptModalOpen(false)}
              >
                Закрыть
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Task Scheduler & Autopilot Modal (Stage 4) ───────────────────────── */}
      {schedulerModalOpen && (
        <Modal
          title="⏱️ Планировщик задач и Автопилот (Task Scheduler)"
          maxWidth="max-w-4xl"
          onClose={() => setSchedulerModalOpen(false)}
        >
          <div className="space-y-4">
            {/* Top Navigation Tabs */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
              <div className="flex gap-1.5 p-1 bg-surface-2 rounded-lg border border-border/50">
                <button
                  type="button"
                  onClick={() => setSchedulerTab('tasks')}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                    schedulerTab === 'tasks'
                      ? "bg-brand-500 text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                  )}
                >
                  <span>📋 Задачи по расписанию</span>
                  <Badge variant="outline" className="text-[10px] px-1 py-0">{schedules.length}</Badge>
                </button>
                <button
                  type="button"
                  onClick={() => setSchedulerTab('new')}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                    schedulerTab === 'new'
                      ? "bg-brand-500 text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                  )}
                >
                  <span>➕ Создать задачу</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSchedulerTab('history')}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                    schedulerTab === 'history'
                      ? "bg-brand-500 text-white shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                  )}
                >
                  <span>📜 История запусков</span>
                  {activeHistorySchedule && (
                    <span className="text-[10px] bg-brand-500/20 text-brand-300 px-1 rounded truncate max-w-[120px]">
                      {activeHistorySchedule.name}
                    </span>
                  )}
                </button>
              </div>

              <div className="flex items-center gap-2 text-xs text-text-tertiary">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Автопилот активен 24/7 (сервер Linux)</span>
              </div>
            </div>

            {/* Notification feedback */}
            {schedulerFeedback && (
              <div className="p-3 bg-brand-500/15 border border-brand-500/40 rounded-xl text-brand-300 text-xs flex items-center justify-between">
                <span>{schedulerFeedback}</span>
                <button onClick={() => setSchedulerFeedback(null)} className="text-brand-400 hover:text-white">✕</button>
              </div>
            )}

            {/* TAB 1: ACTIVE TASKS LIST */}
            {schedulerTab === 'tasks' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">
                    Задачи выполняются сервером автоматически по расписанию через туннель к стойке.
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={async () => {
                      setSchedulerLoading(true);
                      const res = await accountFarmApi.listSchedules();
                      if (res.ok) setSchedules(res.schedules);
                      setSchedulerLoading(false);
                    }}
                  >
                    🔄 Обновить
                  </Button>
                </div>

                {schedulerLoading ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-2">
                    <LoadingSpinner size={24} />
                    <span className="text-xs text-text-secondary">Загрузка расписаний...</span>
                  </div>
                ) : schedules.length === 0 ? (
                  <div className="p-8 text-center text-text-secondary bg-surface-2 rounded-xl border border-border space-y-2">
                    <p className="text-sm font-semibold text-text-primary">Нет активных задач в расписании</p>
                    <p className="text-xs text-text-tertiary">
                      Настройте автоматический прогрев Wildberries, скролл Reels или сброс кэша по таймеру.
                    </p>
                    <Button size="sm" variant="primary" onClick={() => setSchedulerTab('new')}>
                      ➕ Создать первую задачу
                    </Button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[420px] overflow-y-auto pr-1">
                    {schedules.map((sched) => (
                      <div
                        key={sched.id}
                        className={cn(
                          "p-3.5 rounded-xl border space-y-3 transition-all",
                          sched.isActive
                            ? "bg-surface-2 border-border/80 hover:border-brand-500/50"
                            : "bg-surface-2/40 border-border/40 opacity-70"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-0.5 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={cn("w-2 h-2 rounded-full shrink-0", sched.isActive ? "bg-emerald-400" : "bg-zinc-500")} />
                              <h4 className="text-xs font-semibold text-text-primary truncate">{sched.name}</h4>
                            </div>
                            {sched.description && (
                              <p className="text-[11px] text-text-secondary line-clamp-1">{sched.description}</p>
                            )}
                          </div>
                          <Badge
                            variant={sched.isActive ? "success" : "default"}
                            className="text-[10px] shrink-0"
                          >
                            {sched.isActive ? 'Активно' : 'На паузе'}
                          </Badge>
                        </div>

                        {/* Timing details */}
                        <div className="p-2 bg-surface-3/50 rounded-lg space-y-1 text-[11px]">
                          <div className="flex items-center justify-between text-text-secondary">
                            <span>Расписание:</span>
                            <span className="font-mono text-text-primary font-medium">
                              {sched.triggerType === 'interval' && `Каждые ${sched.intervalMinutes} мин`}
                              {sched.triggerType === 'cron' && `Cron: ${sched.cronExpression}`}
                              {sched.triggerType === 'once' && `Разово: ${sched.runOnceAt ? new Date(sched.runOnceAt).toLocaleString('ru-RU') : '—'}`}
                              {sched.jitterMinutes ? ` (±${sched.jitterMinutes}м джиттер)` : ''}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-text-secondary">
                            <span>Следующий запуск:</span>
                            <span className="font-mono text-brand-300 font-semibold">
                              {sched.nextRunAt && sched.isActive ? new Date(sched.nextRunAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-text-tertiary text-[10px]">
                            <span>Цель:</span>
                            <span>{sched.targetMode === 'all' ? 'Вся стойка (20 плат)' : `${sched.targetDeviceIds?.length || 0} плат`}</span>
                          </div>
                          {sched.lastRunAt && (
                            <div className="flex items-center justify-between text-text-tertiary text-[10px]">
                              <span>Посл. запуск:</span>
                              <span className={cn(
                                "font-mono font-medium",
                                sched.lastRunStatus === 'success' ? "text-emerald-400" : sched.lastRunStatus === 'partial' ? "text-amber-300" : "text-rose-400"
                              )}>
                                {relativeTime(sched.lastRunAt)} ({sched.lastRunStatus || 'ok'})
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center justify-between pt-1 border-t border-border/50 text-xs">
                          <div className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="primary"
                              loading={runningNowId === sched.id}
                              disabled={runningNowId !== null}
                              onClick={() => handleRunScheduleNow(sched)}
                              className="h-7 text-[11px] px-2.5 bg-brand-600 hover:bg-brand-500"
                            >
                              ▶ Запустить сейчас
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleToggleSchedule(sched.id, sched.isActive)}
                              className="h-7 text-[11px] px-2.5"
                            >
                              {sched.isActive ? '⏸ Пауза' : '▶ Включить'}
                            </Button>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleViewScheduleHistory(sched)}
                              className="h-7 text-[11px] px-2 text-text-tertiary hover:text-text-primary"
                              title="История запусков"
                            >
                              📜
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleDeleteSchedule(sched.id)}
                              className="h-7 text-[11px] px-2 text-rose-400 hover:bg-rose-500/10"
                              title="Удалить"
                            >
                              🗑️
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: CREATE SCHEDULE FORM */}
            {schedulerTab === 'new' && (
              <div className="space-y-4 max-h-[460px] overflow-y-auto pr-1">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-text-secondary">Название задачи *</label>
                    <Input
                      value={newSchedName}
                      onChange={(e) => setNewSchedName(e.target.value)}
                      placeholder="Например: Авто-прогрев Wildberries каждые 2 часа"
                      className="text-xs h-8 bg-surface-2"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-text-secondary">Описание (опционально)</label>
                    <Input
                      value={newSchedDesc}
                      onChange={(e) => setNewSchedDesc(e.target.value)}
                      placeholder="Краткие заметки по задаче..."
                      className="text-xs h-8 bg-surface-2"
                    />
                  </div>
                </div>

                {/* Scenario Selection */}
                <div className="p-3 bg-surface-2 rounded-xl border border-border/80 space-y-3">
                  <div className="flex items-center justify-between border-b border-border/50 pb-2">
                    <span className="text-xs font-semibold text-text-primary">1. Что запускать (Сценарий)</span>
                    <div className="flex gap-2 text-xs">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="actionType"
                          checked={newSchedActionType === 'preset'}
                          onChange={() => setNewSchedActionType('preset')}
                          className="text-brand-500"
                        />
                        <span>Готовый пресет</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="actionType"
                          checked={newSchedActionType === 'custom'}
                          onChange={() => setNewSchedActionType('custom')}
                          className="text-brand-500"
                        />
                        <span>Пользовательский скрипт</span>
                      </label>
                    </div>
                  </div>

                  {newSchedActionType === 'preset' ? (
                    <div className="space-y-2">
                      <select
                        value={newSchedPresetId}
                        onChange={(e) => setNewSchedPresetId(e.target.value)}
                        className="w-full bg-surface-1 border border-border rounded-lg text-xs p-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
                      >
                        {scriptPresets.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.category})
                          </option>
                        ))}
                      </select>

                      {/* Variables if WB */}
                      {newSchedPresetId === 'wb_organic_warmup' && (
                        <div className="grid grid-cols-2 gap-2 pt-1">
                          <div className="space-y-1">
                            <span className="text-[11px] text-text-secondary">Артикул WB (nmId):</span>
                            <Input
                              value={newSchedVariables['SKU'] || ''}
                              onChange={(e) => setNewSchedVariables((prev) => ({ ...prev, SKU: e.target.value }))}
                              placeholder="1145510159"
                              className="text-xs h-7 font-mono bg-surface-1"
                            />
                          </div>
                          <div className="space-y-1">
                            <span className="text-[11px] text-text-secondary">Удержание (сек):</span>
                            <Input
                              value={newSchedVariables['DWELL_SEC'] || '60'}
                              onChange={(e) => setNewSchedVariables((prev) => ({ ...prev, DWELL_SEC: e.target.value }))}
                              placeholder="60"
                              className="text-xs h-7 font-mono bg-surface-1"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {customScripts.length === 0 ? (
                        <p className="text-xs text-text-tertiary">Нет сохраненных пользовательских сценариев. Создайте их в Automation Studio.</p>
                      ) : (
                        <select
                          value={newSchedCustomId}
                          onChange={(e) => setNewSchedCustomId(e.target.value)}
                          className="w-full bg-surface-1 border border-border rounded-lg text-xs p-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
                        >
                          <option value="">-- Выберите скрипт --</option>
                          {customScripts.map((cs) => (
                            <option key={cs.id} value={cs.id}>
                              {cs.name} ({cs.engine})
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>

                {/* Trigger / Schedule Configuration */}
                <div className="p-3 bg-surface-2 rounded-xl border border-border/80 space-y-3">
                  <div className="flex items-center justify-between border-b border-border/50 pb-2">
                    <span className="text-xs font-semibold text-text-primary">2. Когда запускать (Расписание)</span>
                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setNewSchedTriggerType('interval')}
                        className={cn("px-2 py-0.5 rounded border text-[11px]", newSchedTriggerType === 'interval' ? "bg-brand-500 text-white border-brand-500" : "bg-surface-3 border-border text-text-secondary")}
                      >
                        Интервал
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewSchedTriggerType('cron')}
                        className={cn("px-2 py-0.5 rounded border text-[11px]", newSchedTriggerType === 'cron' ? "bg-brand-500 text-white border-brand-500" : "bg-surface-3 border-border text-text-secondary")}
                      >
                        Cron
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewSchedTriggerType('once')}
                        className={cn("px-2 py-0.5 rounded border text-[11px]", newSchedTriggerType === 'once' ? "bg-brand-500 text-white border-brand-500" : "bg-surface-3 border-border text-text-secondary")}
                      >
                        Разово
                      </button>
                    </div>
                  </div>

                  {newSchedTriggerType === 'interval' && (
                    <div className="grid grid-cols-2 gap-3 items-center">
                      <div className="space-y-1">
                        <label className="text-[11px] text-text-secondary">Интервал повтора:</label>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min="1"
                            value={newSchedIntervalMins}
                            onChange={(e) => setNewSchedIntervalMins(parseInt(e.target.value, 10) || 60)}
                            className="text-xs h-8 font-mono bg-surface-1 w-24"
                          />
                          <span className="text-xs text-text-secondary">минут ({Math.round(newSchedIntervalMins / 60 * 10) / 10} ч.)</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 pt-4">
                        {[30, 60, 120, 180, 360, 720].map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setNewSchedIntervalMins(m)}
                            className="px-2 py-0.5 rounded border border-border text-[10px] bg-surface-1 hover:border-brand-500"
                          >
                            {m >= 60 ? `${m / 60} ч.` : `${m} м.`}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {newSchedTriggerType === 'cron' && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Input
                          value={newSchedCron}
                          onChange={(e) => setNewSchedCron(e.target.value)}
                          placeholder="0 9,15,21 * * *"
                          className="text-xs h-8 font-mono bg-surface-1"
                        />
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-[10px]">
                        <span className="text-text-tertiary">Быстрый выбор:</span>
                        <button type="button" onClick={() => setNewSchedCron('0 * * * *')} className="hover:underline text-brand-400">Каждый час</button>
                        <span>·</span>
                        <button type="button" onClick={() => setNewSchedCron('0 */2 * * *')} className="hover:underline text-brand-400">Каждые 2 часа</button>
                        <span>·</span>
                        <button type="button" onClick={() => setNewSchedCron('0 9,14,20 * * *')} className="hover:underline text-brand-400">В 09:00, 14:00, 20:00</button>
                        <span>·</span>
                        <button type="button" onClick={() => setNewSchedCron('0 4 * * *')} className="hover:underline text-brand-400">Ночью (04:00)</button>
                      </div>
                    </div>
                  )}

                  {newSchedTriggerType === 'once' && (
                    <div className="space-y-1">
                      <label className="text-[11px] text-text-secondary">Дата и время разового запуска:</label>
                      <Input
                        type="datetime-local"
                        value={newSchedRunOnceAt}
                        onChange={(e) => setNewSchedRunOnceAt(e.target.value)}
                        className="text-xs h-8 font-mono bg-surface-1"
                      />
                    </div>
                  )}

                  {/* Anti-detection Jitter */}
                  <div className="pt-2 border-t border-border/50 flex items-center justify-between text-xs">
                    <div className="space-y-0.5">
                      <span className="font-medium text-text-primary">🛡️ Антифрод-джиттер (рандомизация):</span>
                      <p className="text-[10px] text-text-tertiary">Сдвигает запуск на случайное число минут для естественного поведения</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-text-secondary font-mono">±</span>
                      <Input
                        type="number"
                        min="0"
                        max="60"
                        value={newSchedJitterMins}
                        onChange={(e) => setNewSchedJitterMins(parseInt(e.target.value, 10) || 0)}
                        className="text-xs h-7 font-mono bg-surface-1 w-16"
                      />
                      <span className="text-text-secondary text-[11px]">мин.</span>
                    </div>
                  </div>
                </div>

                {/* Target Devices Selection */}
                <div className="p-3 bg-surface-2 rounded-xl border border-border/80 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-text-primary">3. На каких платах исполнять</span>
                    <select
                      value={newSchedTargetMode}
                      onChange={(e) => setNewSchedTargetMode(e.target.value as any)}
                      className="bg-surface-1 border border-border rounded text-xs px-2 py-0.5 text-text-primary"
                    >
                      <option value="all">Вся стойка (20 плат)</option>
                      <option value="custom">Выбранные платы ({newSchedTargetDeviceIds.length})</option>
                    </select>
                  </div>

                  {newSchedTargetMode === 'custom' && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-1.5 max-h-24 overflow-y-auto pt-1">
                      {devices.map((d) => (
                        <label key={d.deviceId} className="flex items-center gap-1 text-[10px] font-mono cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newSchedTargetDeviceIds.includes(d.deviceId)}
                            onChange={(e) => {
                              if (e.target.checked) setNewSchedTargetDeviceIds((prev) => [...prev, d.deviceId]);
                              else setNewSchedTargetDeviceIds((prev) => prev.filter((id) => id !== d.deviceId));
                            }}
                            className="rounded border-border text-brand-500"
                          />
                          <span className="truncate">{d.deviceId}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex justify-end pt-2 border-t border-border">
                  <Button
                    size="sm"
                    variant="primary"
                    loading={savingSchedule}
                    disabled={savingSchedule}
                    onClick={handleCreateSchedule}
                    className="bg-brand-600 hover:bg-brand-500 text-xs px-5"
                  >
                    💾 Сохранить и включить автопилот
                  </Button>
                </div>
              </div>
            )}

            {/* TAB 3: HISTORY LOGS */}
            {schedulerTab === 'history' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-text-primary">
                      {activeHistorySchedule ? `История прогонов: "${activeHistorySchedule.name}"` : 'История прогонов задачи'}
                    </span>
                    {activeHistorySchedule && (
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {activeHistorySchedule.triggerType}
                      </Badge>
                    )}
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      if (activeHistorySchedule) handleViewScheduleHistory(activeHistorySchedule);
                    }}
                  >
                    🔄 Обновить логи
                  </Button>
                </div>

                {historyLoading ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-2">
                    <LoadingSpinner size={24} />
                    <span className="text-xs text-text-secondary">Загрузка журнала прогонов...</span>
                  </div>
                ) : historyLogs.length === 0 ? (
                  <div className="p-8 text-center text-text-secondary bg-surface-2 rounded-xl border border-border">
                    <p className="text-sm font-medium text-text-primary mb-1">История пуста</p>
                    <p className="text-xs text-text-tertiary">
                      Задача ещё не выполнялась. Нажмите «▶ Запустить сейчас» в списке задач для немедленного тестового прогона.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                    {historyLogs.map((log) => (
                      <div
                        key={log.id}
                        className={cn(
                          "p-3 rounded-xl border text-xs space-y-2",
                          log.status === 'success' ? "bg-emerald-500/5 border-emerald-500/30" : log.status === 'partial' ? "bg-amber-500/5 border-amber-500/30" : "bg-rose-500/5 border-rose-500/30"
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 font-mono">
                            <span className={cn("font-bold text-[11px]", log.status === 'success' ? "text-emerald-400" : log.status === 'partial' ? "text-amber-400" : "text-rose-400")}>
                              {log.status === 'success' ? '✓ Успешно' : log.status === 'partial' ? '⚠️ Частично' : '❌ Ошибка'}
                            </span>
                            <span className="text-text-tertiary">·</span>
                            <span className="text-text-secondary text-[11px]">
                              {new Date(log.startedAt).toLocaleString('ru-RU')}
                            </span>
                          </div>
                          <span className="font-mono text-text-tertiary text-[11px]">
                            {(log.durationMs / 1000).toFixed(1)} сек
                          </span>
                        </div>

                        <div className="flex items-center justify-between text-[11px] text-text-secondary">
                          <span>Обработано плат: <strong className="text-text-primary">{log.successful}</strong> / {log.targetsCount}</span>
                          {log.failed > 0 && <span className="text-rose-400 font-semibold">{log.failed} плат с ошибкой</span>}
                        </div>

                        {/* Per-device tags */}
                        {log.devices && Object.keys(log.devices).length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-1 border-t border-border/40">
                            {Object.entries(log.devices).map(([serial, dev]) => (
                              <span
                                key={serial}
                                className={cn(
                                  "px-1.5 py-0.5 rounded text-[10px] font-mono border",
                                  dev.ok ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" : "bg-rose-500/10 border-rose-500/30 text-rose-300"
                                )}
                              >
                                {serial}: {dev.ok ? `✓ ${dev.stepsExecuted}/${dev.totalSteps}` : '✕'}
                              </span>
                            ))}
                          </div>
                        )}

                        {log.error && (
                          <p className="text-[11px] text-rose-400 pt-1">
                            Ошибка: {log.error}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Bottom Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <Button size="sm" variant="ghost" onClick={() => setSchedulerModalOpen(false)}>
                Закрыть
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Stage 5: Network Hub & Proxy Management Modal ── */}
      {networkModalOpen && (
        <Modal
          title="🌐 Сетевой менеджмент & Proxy Hub (Ферма без SIM-карт)"
          maxWidth="max-w-5xl"
          onClose={() => setNetworkModalOpen(false)}
        >
          <div className="space-y-4 text-xs">
            {/* Context Notice */}
            <div className="p-3 bg-cyan-950/30 border border-cyan-500/30 rounded-lg text-cyan-200 flex items-start gap-2.5">
              <span className="text-base">🔌</span>
              <div>
                <strong className="block font-semibold">Архитектура фермы: 20 плат без SIM-карт, подключенных по Ethernet</strong>
                <p className="text-[11px] text-cyan-300/80 pt-0.5">
                  Так как в платах нет физических SIM-карт и мобильных модемов, переключение режима «В самолете» (Airplane Mode) недоступно. Ротация IP производится через Webhook провайдера прокси, а сброс зависших соединений — аппаратным перезапуском интерфейса eth0 и очисткой DNS-кэша.
                </p>
              </div>
            </div>

            {/* Feedback alert */}
            {networkFeedbackMsg && (
              <div className="p-3 rounded-lg bg-surface-2 border border-brand-500/40 text-brand-300 flex items-center justify-between">
                <span>{networkFeedbackMsg}</span>
                <button
                  onClick={() => setNetworkFeedbackMsg(null)}
                  className="text-text-tertiary hover:text-text-primary px-1 font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Tabs Header */}
            <div className="flex border-b border-border gap-2">
              <button
                type="button"
                onClick={() => setNetworkTab('anti_leak')}
                className={cn(
                  "px-3 py-2 font-medium border-b-2 transition-colors",
                  networkTab === 'anti_leak'
                    ? "border-cyan-500 text-cyan-400 font-semibold"
                    : "border-transparent text-text-secondary hover:text-text-primary"
                )}
              >
                🌐 Ротация IP и Anti-Leak (20 плат)
              </button>
              <button
                type="button"
                onClick={() => setNetworkTab('restart_net')}
                className={cn(
                  "px-3 py-2 font-medium border-b-2 transition-colors",
                  networkTab === 'restart_net'
                    ? "border-cyan-500 text-cyan-400 font-semibold"
                    : "border-transparent text-text-secondary hover:text-text-primary"
                )}
              >
                ⚡ Перезапуск сетевых интерфейсов (Ethernet)
              </button>
              <button
                type="button"
                onClick={() => setNetworkTab('batch_proxy')}
                className={cn(
                  "px-3 py-2 font-medium border-b-2 transition-colors",
                  networkTab === 'batch_proxy'
                    ? "border-cyan-500 text-cyan-400 font-semibold"
                    : "border-transparent text-text-secondary hover:text-text-primary"
                )}
              >
                📦 Пакетное распределение пула прокси (1-к-1)
              </button>
            </div>

            {/* TAB 1: Anti-Leak & IP Rotation */}
            {networkTab === 'anti_leak' && (
              <div className="space-y-4">
                {/* Stats Summary */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="p-3 bg-surface-2 rounded-lg border border-border">
                    <span className="text-[11px] text-text-tertiary">Всего устройств</span>
                    <p className="text-xl font-bold text-text-primary">{devices.length}</p>
                  </div>
                  <div className="p-3 bg-surface-2 rounded-lg border border-border">
                    <span className="text-[11px] text-text-tertiary">С прокси</span>
                    <p className="text-xl font-bold text-brand-400">
                      {devices.filter((d) => d.proxy).length}
                    </p>
                  </div>
                  <div className="p-3 bg-surface-2 rounded-lg border border-border">
                    <span className="text-[11px] text-text-tertiary">Защищены (Anti-Leak Safe)</span>
                    <p className="text-xl font-bold text-emerald-400">
                      {devices.filter((d) => {
                        const c = ipResults[d.deviceId];
                        return c && c.ok && !c.leakDetected && Boolean(d.proxy);
                      }).length}
                    </p>
                  </div>
                  <div className="p-3 bg-surface-2 rounded-lg border border-border">
                    <span className="text-[11px] text-text-tertiary">🚨 Утечки прямого IP</span>
                    <p className="text-xl font-bold text-rose-400">
                      {devices.filter((d) => {
                        const c = ipResults[d.deviceId];
                        return c && c.leakDetected;
                      }).length}
                    </p>
                  </div>
                </div>

                {/* Batch Actions Bar */}
                <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-surface-2/40 rounded-lg border border-border/60">
                  <div className="text-text-secondary text-xs">
                    Одновременные сетевые операции по всей стойке:
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      loading={batchCheckingIps}
                      onClick={handleBatchCheckIps}
                      className="border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
                    >
                      🔍 Проверить IP на всех 20 платах
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
                      onClick={handleBatchRotateIp}
                    >
                      🔄 Сменить IP на всех платах (Webhook)
                    </Button>
                  </div>
                </div>

                {/* Device Anti-Leak Table */}
                <div className="border border-border rounded-lg overflow-hidden max-h-[420px] overflow-y-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-surface-2 text-text-secondary text-[11px] border-b border-border sticky top-0 z-10">
                      <tr>
                        <th className="p-2.5">Плата</th>
                        <th className="p-2.5">Прокси</th>
                        <th className="p-2.5">Внешний IP / Гео</th>
                        <th className="p-2.5">Anti-Leak Статус</th>
                        <th className="p-2.5">Ссылка ротации (Webhook)</th>
                        <th className="p-2.5 text-right">Действия</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40 font-mono text-[11px]">
                      {devices.map((device, idx) => {
                        const check = ipResults[device.deviceId];
                        const isRotating = rotatingDeviceIds[device.deviceId];
                        const rotUrl = editingRotateUrl[device.deviceId] ?? device.proxy?.rotateUrl ?? '';

                        return (
                          <tr key={device.deviceId} className="hover:bg-surface-2/30 transition-colors">
                            <td className="p-2.5 font-sans font-medium text-text-primary whitespace-nowrap">
                              <span className="text-text-tertiary mr-1.5 font-mono">#{idx + 1}</span>
                              {device.name}
                              <span className="block text-[10px] text-text-tertiary font-mono">{device.deviceId}</span>
                            </td>
                            <td className="p-2.5">
                              {device.proxy ? (
                                <div>
                                  <span className="text-text-primary font-semibold">
                                    {device.proxy.host}:{device.proxy.port}
                                  </span>
                                  <Badge variant="outline" className="ml-1 text-[9px] px-1 py-0">
                                    {device.proxy.type || 'http'}
                                  </Badge>
                                </div>
                              ) : (
                                <span className="text-text-tertiary font-sans">Прямой интернет</span>
                              )}
                            </td>
                            <td className="p-2.5">
                              {check ? (
                                check.ok ? (
                                  <div>
                                    <span className="text-text-primary font-bold">{check.ip}</span>
                                    {(check.country || check.city) && (
                                      <span className="block text-[10px] text-text-secondary font-sans">
                                        📍 {check.country} {check.city ? `(${check.city})` : ''}
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-rose-400 font-sans">{check.error || 'Ошибка связи'}</span>
                                )
                              ) : (
                                <span className="text-text-tertiary font-sans italic">Не проверен</span>
                              )}
                            </td>
                            <td className="p-2.5 font-sans">
                              {check?.leakDetected ? (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-semibold animate-pulse">
                                  🚨 УТЕЧКА (IP хоста!)
                                </span>
                              ) : check?.ok && device.proxy ? (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[10px]">
                                  🛡️ Защищен
                                </span>
                              ) : check?.ok ? (
                                <span className="text-text-tertiary text-[10px]">Прямой доступ</span>
                              ) : (
                                <span className="text-text-tertiary text-[10px]">—</span>
                              )}
                            </td>
                            <td className="p-2.5 font-sans max-w-[220px]">
                              <div className="flex items-center gap-1">
                                <Input
                                  placeholder="https://...rotate_url"
                                  value={rotUrl}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setEditingRotateUrl((prev) => ({ ...prev, [device.deviceId]: val }));
                                  }}
                                  className="text-[10px] py-1 h-7 font-mono truncate"
                                />
                              </div>
                            </td>
                            <td className="p-2.5 text-right font-sans whitespace-nowrap">
                              <div className="flex items-center justify-end gap-1.5">
                                <Button
                                  size="sm"
                                  variant="primary"
                                  loading={isRotating}
                                  disabled={!rotUrl}
                                  onClick={() => handleRotateIp(device.deviceId, rotUrl)}
                                  className="text-[11px] py-1 h-7 bg-indigo-600 hover:bg-indigo-500"
                                >
                                  🔄 Сменить IP
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleCheckIp(device.deviceId)}
                                  className="text-[11px] py-1 h-7"
                                >
                                  🔍
                                </Button>
                                {device.proxy && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleClearProxy(device.deviceId)}
                                    className="text-rose-400 hover:text-rose-300 text-[11px] py-1 h-7 px-1.5"
                                    title="Сбросить прокси"
                                  >
                                    ✕
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* TAB 2: Network Interfaces Restart (eth0 / wlan0) */}
            {networkTab === 'restart_net' && (
              <div className="space-y-4">
                <div className="p-4 bg-surface-2 rounded-xl border border-border space-y-3">
                  <h4 className="font-semibold text-text-primary text-sm">
                    Параметры аппаратного перезапуска сети (Ethernet single-switch)
                  </h4>
                  <p className="text-text-secondary text-xs">
                    Выполняет команды <code className="text-cyan-300 bg-surface-1 px-1 py-0.5 rounded font-mono">ndc resolver flushdefaultif</code>, <code className="text-cyan-300 bg-surface-1 px-1 py-0.5 rounded font-mono">ip route flush cache</code> и переинициализирует адаптер интерфейса (<code className="text-cyan-300 bg-surface-1 px-1 py-0.5 rounded font-mono">eth0 down/up</code>).
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
                    <label
                      onClick={() => setRestartNetMode('ethernet')}
                      className={cn(
                        "p-3 rounded-lg border cursor-pointer transition-all flex items-start gap-2.5",
                        restartNetMode === 'ethernet'
                          ? "border-cyan-500 bg-cyan-500/10 text-cyan-200"
                          : "border-border bg-surface-1 text-text-secondary hover:border-border/80"
                      )}
                    >
                      <input
                        type="radio"
                        name="restartNetMode"
                        checked={restartNetMode === 'ethernet'}
                        onChange={() => setRestartNetMode('ethernet')}
                        className="mt-0.5"
                      />
                      <div>
                        <strong className="block font-semibold text-text-primary">eth0 (Ethernet)</strong>
                        <span className="text-[11px] text-text-tertiary">
                          Рекомендуется для 20-платной стойки без SIM-карт
                        </span>
                      </div>
                    </label>

                    <label
                      onClick={() => setRestartNetMode('wifi')}
                      className={cn(
                        "p-3 rounded-lg border cursor-pointer transition-all flex items-start gap-2.5",
                        restartNetMode === 'wifi'
                          ? "border-cyan-500 bg-cyan-500/10 text-cyan-200"
                          : "border-border bg-surface-1 text-text-secondary hover:border-border/80"
                      )}
                    >
                      <input
                        type="radio"
                        name="restartNetMode"
                        checked={restartNetMode === 'wifi'}
                        onChange={() => setRestartNetMode('wifi')}
                        className="mt-0.5"
                      />
                      <div>
                        <strong className="block font-semibold text-text-primary">wlan0 (Wi-Fi)</strong>
                        <span className="text-[11px] text-text-tertiary">
                          svc wifi disable & enable
                        </span>
                      </div>
                    </label>

                    <label
                      onClick={() => setRestartNetMode('all')}
                      className={cn(
                        "p-3 rounded-lg border cursor-pointer transition-all flex items-start gap-2.5",
                        restartNetMode === 'all'
                          ? "border-cyan-500 bg-cyan-500/10 text-cyan-200"
                          : "border-border bg-surface-1 text-text-secondary hover:border-border/80"
                      )}
                    >
                      <input
                        type="radio"
                        name="restartNetMode"
                        checked={restartNetMode === 'all'}
                        onChange={() => setRestartNetMode('all')}
                        className="mt-0.5"
                      />
                      <div>
                        <strong className="block font-semibold text-text-primary">Все интерфейсы</strong>
                        <span className="text-[11px] text-text-tertiary">
                          Полный сброс eth0 + wlan0 + DNS
                        </span>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Target Device Selector */}
                <div className="p-4 bg-surface-2 rounded-xl border border-border space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-text-primary">
                      Целевые платы для перезапуска ({restartTargetDeviceIds.length} / {devices.length}):
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setRestartTargetDeviceIds(devices.map((d) => d.deviceId))}
                        className="text-[11px] text-cyan-400 hover:underline"
                      >
                        Выбрать все 20 плат
                      </button>
                      <span className="text-text-tertiary">|</span>
                      <button
                        type="button"
                        onClick={() => setRestartTargetDeviceIds([])}
                        className="text-[11px] text-text-secondary hover:underline"
                      >
                        Снять выделение
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 md:grid-cols-5 lg:grid-cols-10 gap-1.5">
                    {devices.map((d, i) => {
                      const isChecked = restartTargetDeviceIds.includes(d.deviceId);
                      return (
                        <button
                          key={d.deviceId}
                          type="button"
                          onClick={() => {
                            setRestartTargetDeviceIds((prev) =>
                              prev.includes(d.deviceId)
                                ? prev.filter((id) => id !== d.deviceId)
                                : [...prev, d.deviceId]
                            );
                          }}
                          className={cn(
                            "px-2 py-1 rounded text-center border font-mono text-[11px] transition-all",
                            isChecked
                              ? "bg-cyan-500/20 border-cyan-500/60 text-cyan-200 font-semibold"
                              : "bg-surface-1 border-border/60 text-text-tertiary hover:border-border"
                          )}
                        >
                          #{i + 1}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Execute Button */}
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    loading={restartingNet}
                    onClick={handleRestartNetwork}
                    className="bg-cyan-600 hover:bg-cyan-500 text-white font-semibold flex items-center gap-1.5"
                  >
                    ⚡ Перезапустить интерфейс ({restartNetMode}) на {restartTargetDeviceIds.length} платах
                  </Button>
                </div>

                {/* Restart Logs */}
                {restartLogs.length > 0 && (
                  <div className="space-y-2 border border-border rounded-lg p-3 bg-surface-2/40 max-h-52 overflow-y-auto">
                    <span className="font-semibold text-text-primary text-[11px]">Журнал сброса интерфейсов:</span>
                    <div className="space-y-1 font-mono text-[11px]">
                      {restartLogs.map((log) => (
                        <div
                          key={log.deviceId}
                          className={cn(
                            "flex items-center justify-between p-1.5 rounded border",
                            log.ok ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300" : "bg-rose-500/10 border-rose-500/20 text-rose-300"
                          )}
                        >
                          <span>{log.deviceId} ({log.mode}):</span>
                          <span>{log.log}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: Batch Proxy Pool Distribution (1-to-1) */}
            {networkTab === 'batch_proxy' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="font-semibold text-text-primary text-xs">
                      Вставьте список прокси (один на строку):
                    </label>
                    <span className="text-[11px] text-text-tertiary">
                      Распознано: <strong className="text-cyan-300">{parseBatchProxyLines(batchProxyText).length}</strong> шт.
                    </span>
                  </div>
                  <Textarea
                    rows={6}
                    placeholder={`185.123.45.67:8080:user:pass:https://mobileproxy.space/reload.html?proxy_key=xxx\n185.123.45.68:8080:user:pass|https://mobileproxy.space/reload.html?proxy_key=yyy\nhttp://admin:secret@185.123.45.69:8080\n185.123.45.70:8080`}
                    value={batchProxyText}
                    onChange={(e) => setBatchProxyText(e.target.value)}
                    className="font-mono text-[11px]"
                  />
                  <div className="flex flex-wrap gap-2 text-[10px] text-text-tertiary">
                    <span>Поддерживаемые форматы:</span>
                    <code className="bg-surface-2 px-1 rounded text-cyan-400">host:port:user:pass:rotateUrl</code>
                    <code className="bg-surface-2 px-1 rounded text-cyan-400">host:port:user:pass|rotateUrl</code>
                    <code className="bg-surface-2 px-1 rounded text-cyan-400">http://user:pass@host:port</code>
                    <code className="bg-surface-2 px-1 rounded text-cyan-400">host:port</code>
                  </div>
                </div>

                {/* Proxy Protocol / Type */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <div>
                    <label className="text-[11px] text-text-secondary block mb-1">Тип прокси:</label>
                    <select
                      value={batchProxyType}
                      onChange={(e) => setBatchProxyType(e.target.value as any)}
                      className="w-full bg-surface-2 border border-border rounded-lg p-2 text-text-primary text-xs"
                    >
                      <option value="http">HTTP / HTTPS</option>
                      <option value="socks5">SOCKS5</option>
                      <option value="mobile">Мобильный 4G / LTE</option>
                      <option value="residential">Резидентский</option>
                    </select>
                  </div>
                </div>

                {/* Preview Table */}
                {parseBatchProxyLines(batchProxyText).length > 0 && (
                  <div className="space-y-1.5">
                    <span className="font-semibold text-text-primary text-[11px]">
                      Предпросмотр распределения 1-к-1:
                    </span>
                    <div className="border border-border rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                      <table className="w-full text-left border-collapse font-mono text-[11px]">
                        <thead className="bg-surface-2 text-text-secondary text-[10px] border-b border-border sticky top-0">
                          <tr>
                            <th className="p-2">№</th>
                            <th className="p-2">Целевая плата</th>
                            <th className="p-2">Host:Port</th>
                            <th className="p-2">Авторизация</th>
                            <th className="p-2">Webhook ротации</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40">
                          {parseBatchProxyLines(batchProxyText).map((item, idx) => {
                            const targetId = batchProxyTargets[idx] || `— (Плат меньше, чем прокси)`;
                            return (
                              <tr key={idx} className="hover:bg-surface-2/30">
                                <td className="p-2 text-text-tertiary">#{idx + 1}</td>
                                <td className="p-2 font-sans font-semibold text-text-primary">{targetId}</td>
                                <td className="p-2 text-cyan-300 font-bold">{item.host}:{item.port}</td>
                                <td className="p-2 text-text-secondary">{item.username ? `${item.username}:***` : 'Без логина'}</td>
                                <td className="p-2 text-[10px] truncate max-w-[180px] text-text-tertiary">
                                  {item.rotateUrl || '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex justify-end gap-2 pt-2 border-t border-border">
                  <Button
                    size="sm"
                    variant="primary"
                    loading={batchProxyApplying}
                    disabled={parseBatchProxyLines(batchProxyText).length === 0}
                    onClick={handleApplyBatchProxies}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                  >
                    🚀 Применить прокси 1-к-1 ({Math.min(parseBatchProxyLines(batchProxyText).length, batchProxyTargets.length)} плат)
                  </Button>
                </div>
              </div>
            )}

            {/* Bottom Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <Button size="sm" variant="ghost" onClick={() => setNetworkModalOpen(false)}>
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


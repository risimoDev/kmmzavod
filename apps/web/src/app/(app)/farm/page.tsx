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
import { relativeTime, cn } from "@/lib/utils";
import {
  accountFarmApi,
  getAccessToken,
  type AccountGroup,
  type Proxy,
  type FarmSocialAccount,
  type FarmMetrics,
} from "@/lib/api";

const TABS = [
  { value: "overview", label: "Overview" },
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
        {tab === "groups" && <GroupsTab />}
        {tab === "proxies" && <ProxiesTab />}
        {tab === "accounts" && <AccountsTab />}
      </main>
    </>
  );
}

// ── Overview / Metrics ────────────────────────────────────────────────────────

function OverviewTab() {
  const [metrics, setMetrics] = useState<FarmMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMetrics(await accountFarmApi.metrics());
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

  if (loading) return <CenterSpinner />;
  if (error) return <ErrorRetry error={error} onRetry={load} />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="primary" size="sm" onClick={() => setShowImport(true)}>Bulk Import</Button>
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
  method: "official" | "private",
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
  const [authMethod, setAuthMethod] = useState<"official" | "private">("official");
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
                    <span className="text-sm font-medium text-text-primary truncate">{a.accountName}</span>
                    <Badge variant="outline" className="text-2xs capitalize">{a.platform}</Badge>
                    {a.authMethod === "private" && <Badge variant="brand" className="text-2xs">private</Badge>}
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

          {authMethod === "private" && (platform === "youtube_shorts" || platform === "postbridge") && (
            <p className="text-xs text-warning">
              Приватный метод поддерживается только для TikTok и Instagram. Для {platform} используйте Official API.
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
  const tone = score >= 70 ? "success" : score >= 40 ? "warning" : "danger";
  return <Badge variant={tone as any}>{score}/100</Badge>;
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

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface-1 shadow-elevation-3 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">✕</button>
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

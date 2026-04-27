"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/primitives";
import { useTheme } from "@/components/providers/ThemeProvider";
import { getStoredUser, authApi } from "@/lib/api";

// ── Navigation items ──────────────────────────────────────────────────────────

const NAV_ITEMS = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
        <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
      </svg>
    ),
  },
  {
    href: "/projects",
    label: "Projects",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
      </svg>
    ),
  },
  {
    href: "/videos",
    label: "Videos",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="2" y="4" width="20" height="16" rx="2"/>
        <path d="M10 9l5 3-5 3V9z"/>
      </svg>
    ),
  },
  {
    href: "/products",
    label: "Products",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
        <path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>
      </svg>
    ),
  },
  {
    href: "/presets",
    label: "Factories",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 10c0-4.418-3.582-8-8-8s-8 3.582-8 8c0 4.418 3.582 8 8 8s8-3.582 8-8z" />
        <path d="M12 22v-4M8 22v-4M16 22v-4M7 10h10M12 6v8" />
      </svg>
    ),
  },
  {
    href: "/create",
    label: "Create",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>
      </svg>
    ),
    highlight: true,
  },
] as { href: string; label: string; icon: React.ReactNode; highlight?: boolean }[];

const NAV_BOTTOM = [
  {
    href: "/admin",
    label: "Admin",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
      </svg>
    ),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
      </svg>
    ),
  },
];


// ── Sidebar ───────────────────────────────────────────────────────────────────

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [user, setUser] = useState<{ email: string; displayName?: string; role: string; platformRole?: string } | null>(null);

  useEffect(() => {
    setUser(getStoredUser());
  }, []);

  const isSuperAdmin = user?.platformRole === 'super_admin';

  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 flex flex-col w-[216px] border-r"
      style={{
        background: "hsl(var(--sidebar-bg))",
        borderColor: "hsl(var(--sidebar-border))",
      }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 h-14 px-4 border-b" style={{ borderColor: "hsl(var(--sidebar-border))" }}>
        <LogoMark />
        <span className="font-semibold tracking-tight text-sm text-text-primary">kmmzavod</span>
        <span className="ml-auto">
          <span className="text-xs font-medium text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded-md">AI</span>
        </span>
      </div>

      {/* Main nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 h-8 px-2.5 rounded-md text-sm font-medium transition-colors duration-150",
                  pathname.startsWith(item.href)
                    ? "bg-brand-500/10 text-brand-400"
                    : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
                  item.highlight && !pathname.startsWith(item.href) && "text-brand-400 hover:text-brand-300"
                )}
              >
                <span className="shrink-0">{item.icon}</span>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Section divider */}
        <div className="my-3 h-px bg-border" />

        <p className="px-2.5 mb-1 text-2xs font-semibold uppercase tracking-widest text-text-tertiary">
          System
        </p>
        <ul className="space-y-0.5">
          {NAV_BOTTOM.filter((item) => item.href !== '/admin' || isSuperAdmin).map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 h-8 px-2.5 rounded-md text-sm font-medium transition-colors duration-150",
                  pathname.startsWith(item.href)
                    ? "bg-brand-500/10 text-brand-400"
                    : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                )}
              >
                <span className="shrink-0">{item.icon}</span>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* Bottom — user + theme toggle */}
      <div className="p-3 border-t" style={{ borderColor: "hsl(var(--sidebar-border))" }}>
        <button
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="w-full flex items-center gap-2 h-8 px-2.5 rounded-md text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
        >
          {resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
          {resolvedTheme === "dark" ? "Light theme" : "Dark theme"}
        </button>

        <div className="mt-1 flex items-center gap-2 h-9 px-2.5">
          <div className="w-6 h-6 rounded-full bg-brand-500 flex items-center justify-center text-white text-xs font-semibold shrink-0">
            {(user?.displayName ?? user?.email ?? "?")[0].toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-text-primary truncate">{user?.displayName ?? user?.email ?? "—"}</p>
            <p className="text-2xs text-text-tertiary truncate">{user?.email ?? ""}</p>
          </div>
          <button
            onClick={async () => { await authApi.logout(); router.push("/login"); }}
            title="Log out"
            className="shrink-0 text-text-tertiary hover:text-text-primary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
          </button>
        </div>
      </div>
    </aside>
  );
}


// ── Top bar ───────────────────────────────────────────────────────────────────

interface TopBarProps {
  title?: string;
  actions?: React.ReactNode;
}

export function TopBar({ title, actions }: TopBarProps) {
  return (
    <header className="h-14 border-b border-border bg-surface-0/80 backdrop-blur-sm flex items-center px-6 gap-4 sticky top-0 z-20">
      {title && <h1 className="text-sm font-semibold text-text-primary">{title}</h1>}
      <div className="flex-1" />
      {actions}
    </header>
  );
}


// ── App shell layout ──────────────────────────────────────────────────────────

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-0">
      <Sidebar />
      <div className="ml-[216px] min-h-screen flex flex-col">
        {children}
      </div>
    </div>
  );
}


// ── Inline icons ──────────────────────────────────────────────────────────────

function LogoMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-label="kmmzavod logo">
      <rect width="22" height="22" rx="6" fill="#7C3AED"/>
      <path d="M6 7l4 4-4 4M11 15h5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="5"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
    </svg>
  );
}

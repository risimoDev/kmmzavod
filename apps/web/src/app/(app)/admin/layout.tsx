"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/layout/AppShell";

const ADMIN_TABS: readonly { href: string; label: string; exact?: boolean }[] = [
  { href: "/admin",               label: "Обзор",          exact: true },
  { href: "/admin/users",         label: "Пользователи" },
  { href: "/admin/tenants",       label: "Тенанты" },
  { href: "/admin/videos",        label: "Видео" },
  { href: "/admin/jobs",          label: "Задачи" },
  { href: "/admin/pipeline-test", label: "Тест пайплайна" },
  { href: "/admin/usage",         label: "Затраты" },
  { href: "/admin/services",      label: "Сервисы" },
  { href: "/admin/settings",      label: "Настройки" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <>
      <TopBar title="Администрирование" />

      {/* Admin sub-navigation */}
      <div className="border-b border-border bg-surface-0 flex-shrink-0">
        <nav className="flex gap-0 px-6 overflow-x-auto" aria-label="Разделы администрирования">
          {ADMIN_TABS.map((tab) => {
            const active = tab.exact
              ? pathname === tab.href
              : pathname.startsWith(tab.href);

            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "px-4 py-3 text-sm font-medium transition-all border-b-2 -mb-px whitespace-nowrap",
                  active
                    ? "border-brand-500 text-brand-400"
                    : "border-transparent text-text-tertiary hover:text-text-secondary hover:border-border"
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </>
  );
}

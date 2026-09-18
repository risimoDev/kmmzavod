"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { notificationsApi, type AppNotification } from "@/lib/api";
import { relativeTime, cn } from "@/lib/utils";

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterUnread, setFilterUnread] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await notificationsApi.unreadCount();
      setUnreadCount(res.unreadCount);
    } catch {
      // ignore
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await notificationsApi.list({
        unreadOnly: filterUnread,
        limit: 25,
      });
      setNotifications(res.items);
      setUnreadCount(res.unreadCount);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [filterUnread]);

  // Periodic poll for unread count
  useEffect(() => {
    fetchUnreadCount();
    const timer = setInterval(fetchUnreadCount, 12000);
    return () => clearInterval(timer);
  }, [fetchUnreadCount]);

  // Load list when popover opens or filter changes
  useEffect(() => {
    if (open) {
      loadNotifications();
    }
  }, [open, loadNotifications]);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const handleNotificationClick = async (item: AppNotification) => {
    if (!item.isRead) {
      try {
        await notificationsApi.markRead(item.id);
        setNotifications((prev) =>
          prev.map((n) => (n.id === item.id ? { ...n, isRead: true } : n)),
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      } catch {
        // ignore
      }
    }
    if (item.actionUrl) {
      setOpen(false);
      router.push(item.actionUrl);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await notificationsApi.markAllRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch {
      // ignore
    }
  };

  return (
    <div className="relative" ref={popoverRef}>
      {/* Bell Button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative w-8 h-8 rounded-lg flex items-center justify-center transition-colors",
          open
            ? "bg-surface-2 text-brand-400"
            : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
        )}
        title="Уведомления"
        aria-label="Уведомления"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute top-1.5 right-1.5 min-w-[15px] h-[15px] px-1 rounded-full bg-danger text-white text-[9px] font-bold flex items-center justify-center shadow-sm animate-pulse">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Popover */}
      {open && (
        <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-xl border border-border bg-surface-1 shadow-elevation-3 z-50 overflow-hidden animate-slide-up">
          {/* Header */}
          <div className="p-3.5 border-b border-border flex items-center justify-between bg-surface-0/60">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-text-primary">Уведомления</span>
              {unreadCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-2xs font-semibold bg-brand-500/15 text-brand-400">
                  {unreadCount} новых
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-2xs font-medium text-brand-400 hover:text-brand-300 transition-colors"
              >
                Прочитать все
              </button>
            )}
          </div>

          {/* Filter Bar */}
          <div className="flex border-b border-border text-xs px-2 py-1 bg-surface-0/30">
            <button
              onClick={() => setFilterUnread(false)}
              className={cn(
                "px-2.5 py-1 rounded-md transition-colors",
                !filterUnread
                  ? "bg-surface-2 font-medium text-text-primary"
                  : "text-text-tertiary hover:text-text-secondary",
              )}
            >
              Все
            </button>
            <button
              onClick={() => setFilterUnread(true)}
              className={cn(
                "px-2.5 py-1 rounded-md transition-colors",
                filterUnread
                  ? "bg-surface-2 font-medium text-text-primary"
                  : "text-text-tertiary hover:text-text-secondary",
              )}
            >
              Только непрочитанные
            </button>
          </div>

          {/* List */}
          <div className="max-h-[380px] overflow-y-auto divide-y divide-border/60">
            {loading ? (
              <div className="py-8 text-center text-xs text-text-tertiary">
                Загрузка…
              </div>
            ) : notifications.length === 0 ? (
              <div className="py-8 text-center text-xs text-text-tertiary">
                {filterUnread ? "Нет непрочитанных уведомлений" : "Уведомлений пока нет"}
              </div>
            ) : (
              notifications.map((item) => {
                const isError = item.type === "job_failed";
                return (
                  <div
                    key={item.id}
                    onClick={() => handleNotificationClick(item)}
                    className={cn(
                      "p-3 transition-colors cursor-pointer flex gap-3 items-start",
                      item.isRead ? "hover:bg-surface-2/40 opacity-75" : "bg-brand-500/5 hover:bg-brand-500/10",
                    )}
                  >
                    {/* Status Icon */}
                    <div
                      className={cn(
                        "w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
                        isError
                          ? "bg-danger/15 text-danger"
                          : "bg-brand-500/15 text-brand-400",
                      )}
                    >
                      {isError ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="12" y1="8" x2="12" y2="12" />
                          <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-1">
                        <p className="text-xs font-semibold text-text-primary truncate">
                          {item.title}
                        </p>
                        <span className="text-3xs text-text-tertiary shrink-0">
                          {relativeTime(item.createdAt)}
                        </span>
                      </div>
                      <p className="text-2xs text-text-secondary mt-0.5 line-clamp-2">
                        {item.body}
                      </p>
                      {item.actionUrl && (
                        <span className="inline-block mt-1 text-3xs font-medium text-brand-400 hover:underline">
                          Перейти →
                        </span>
                      )}
                    </div>

                    {/* Unread indicator */}
                    {!item.isRead && (
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0 mt-1.5" />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

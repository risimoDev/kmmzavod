"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getAccessToken, videosApi } from "@/lib/api";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export interface ProgressEvent {
  stage: string;
  status: string;
  progress: number;
  message: string | null;
  isComplete?: boolean;
  timestamp: string;
}

export interface VideoProgress {
  stage: string;
  progress: number;
  message: string | null;
  isComplete: boolean;
  isFailed: boolean;
  events: ProgressEvent[];
  /** true once SSE gave up after max reconnects — the page should fall back to polling */
  stale: boolean;
}

interface UseVideoProgressOptions {
  enabled?: boolean;
  onComplete?: (finalStatus: string) => void;
  /** Called once when the stream gave up reconnecting (use to start polling) */
  onGiveUp?: () => void;
}

const INITIAL: VideoProgress = {
  stage: "",
  progress: 0,
  message: null,
  isComplete: false,
  isFailed: false,
  events: [],
  stale: false,
};

const MIN_RETRY_DELAY = 1_000;
const MAX_RETRY_DELAY = 30_000;
const MAX_RETRIES = 15;

/**
 * SSE hook for tracking video generation progress in real-time.
 * Connects to GET /api/v1/videos/:id/progress via EventSource.
 *
 * - Auth via httpOnly `sse_token` cookie (POST /auth/sse-token, refresh-aware) so the JWT
 *   stays out of URLs/logs; falls back to `?token=` if the cookie can't be issued/delivered
 * - Exponential backoff on connection errors (1s → 30s); the cookie is re-issued on each retry
 * - Auto-closes on isComplete / isFailed
 * - Optional onComplete callback; `stale` / onGiveUp when reconnects are exhausted
 */
export function useVideoProgress(
  videoId: string,
  opts: UseVideoProgressOptions | boolean = true,
): VideoProgress {
  const enabled = typeof opts === "boolean" ? opts : (opts.enabled ?? true);
  const onComplete = typeof opts === "boolean" ? undefined : opts.onComplete;

  const [state, setState] = useState<VideoProgress>(INITIAL);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef(MIN_RETRY_DELAY);
  const retryCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onGiveUp = typeof opts === "boolean" ? undefined : opts.onGiveUp;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onGiveUpRef = useRef(onGiveUp);
  onGiveUpRef.current = onGiveUp;
  // "cookie" until a cookie-authed connection fails before ever opening, then "query"
  const authModeRef = useRef<"cookie" | "query">("cookie");

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled || !videoId) return;

    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;
      if (!getAccessToken()) return;

      let useCookie = authModeRef.current === "cookie";
      if (useCookie) {
        try {
          // refresh-aware (apiFetch); re-issues the 15-min cookie on every (re)connect
          await videosApi.issueSseToken();
        } catch {
          useCookie = false;
        }
      }
      if (cancelled) return;

      // Read after the await: sse-token may have refreshed the access token
      const token = getAccessToken();
      if (!useCookie && !token) return;

      const base = `${BASE}/api/v1/videos/${videoId}/progress`;
      const es = useCookie
        ? new EventSource(base, { withCredentials: true })
        : new EventSource(`${base}?token=${encodeURIComponent(token)}`);
      esRef.current = es;
      let opened = false;

      es.onopen = () => {
        opened = true;
        // Reset retry state on successful connection
        retryRef.current = MIN_RETRY_DELAY;
        retryCountRef.current = 0;
        setState((prev) => (prev.stale ? { ...prev, stale: false } : prev));
      };

      es.onmessage = (e) => {
        try {
          const data: ProgressEvent = JSON.parse(e.data);
          const isComplete =
            data.isComplete === true ||
            data.progress >= 100 ||
            data.status === "completed";
          const isFailed = data.status === "failed";

          setState((prev) => ({
            stage: data.stage,
            progress: Math.max(prev.progress, data.progress),
            message: data.message,
            isComplete,
            isFailed,
            events: [...prev.events, data],
            stale: false,
          }));

          if (isComplete || isFailed) {
            // Terminal state — close and reset retry delay
            retryRef.current = MIN_RETRY_DELAY;
            es.close();
            esRef.current = null;
            onCompleteRef.current?.(data.status);
          }
        } catch {
          // ignore malformed events
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;

        if (cancelled) return;

        // Cookie never made it (cross-site / Secure on http / rejected) — use ?token= next time
        if (useCookie && !opened) authModeRef.current = "query";

        retryCountRef.current += 1;
        if (retryCountRef.current > MAX_RETRIES) {
          setState((prev) => ({ ...prev, stale: true }));
          onGiveUpRef.current?.();
          return;
        }

        // Exponential backoff with jitter
        const jitter = Math.random() * 500;
        const delay = retryRef.current + jitter;
        retryRef.current = Math.min(retryRef.current * 2, MAX_RETRY_DELAY);
        timerRef.current = setTimeout(connect, delay);
      };
    };

    authModeRef.current = "cookie";
    void connect();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [videoId, enabled, cleanup]);

  return state;
}

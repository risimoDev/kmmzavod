"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getAccessToken } from "@/lib/api";

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
}

interface UseVideoProgressOptions {
  enabled?: boolean;
  onComplete?: (finalStatus: string) => void;
}

const INITIAL: VideoProgress = {
  stage: "",
  progress: 0,
  message: null,
  isComplete: false,
  isFailed: false,
  events: [],
};

const MIN_RETRY_DELAY = 1_000;
const MAX_RETRY_DELAY = 30_000;
const MAX_RETRIES = 15;

/**
 * SSE hook for tracking video generation progress in real-time.
 * Connects to GET /api/v1/videos/:id/progress via EventSource.
 *
 * - Exponential backoff on connection errors (1s → 30s)
 * - Auto-closes on isComplete / isFailed
 * - Optional onComplete callback
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
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

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

    const connect = () => {
      if (cancelled) return;

      const token = getAccessToken();
      if (!token) return;

      const url = `${BASE}/api/v1/videos/${videoId}/progress?token=${encodeURIComponent(token)}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        // Reset retry state on successful connection
        retryRef.current = MIN_RETRY_DELAY;
        retryCountRef.current = 0;
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

        retryCountRef.current += 1;
        if (retryCountRef.current > MAX_RETRIES) return;

        // Exponential backoff with jitter
        const jitter = Math.random() * 500;
        const delay = retryRef.current + jitter;
        retryRef.current = Math.min(retryRef.current * 2, MAX_RETRY_DELAY);
        timerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [videoId, enabled, cleanup]);

  return state;
}

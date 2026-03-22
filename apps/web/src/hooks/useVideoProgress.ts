"use client";

import { useState, useEffect, useRef } from "react";
import { getAccessToken } from "@/lib/api";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export interface ProgressEvent {
  stage: string;
  status: string;
  progress: number;
  message: string | null;
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

const INITIAL: VideoProgress = {
  stage: "",
  progress: 0,
  message: null,
  isComplete: false,
  isFailed: false,
  events: [],
};

/**
 * SSE-хук для отслеживания прогресса генерации видео в реальном времени.
 * Подключается к GET /api/v1/videos/:id/progress через EventSource.
 */
export function useVideoProgress(videoId: string, enabled = true): VideoProgress {
  const [state, setState] = useState<VideoProgress>(INITIAL);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled || !videoId) return;

    const token = getAccessToken();
    if (!token) return;

    const url = `${BASE}/api/v1/videos/${videoId}/progress?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data: ProgressEvent = JSON.parse(e.data);
        const isComplete = data.progress >= 100 || data.status === "completed";
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
          es.close();
        }
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects on transient failures
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [videoId, enabled]);

  return state;
}

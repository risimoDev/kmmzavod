"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// ── Step indicator ────────────────────────────────────────────────────────────

interface Step {
  id: string | number;
  label: string;
}

interface StepperProps {
  steps: Step[];
  current: number; // 0-indexed current active step
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <nav aria-label="Video creation steps">
      <ol className="flex items-center gap-0">
        {steps.map((step, i) => {
          const done    = i < current;
          const active  = i === current;
          const pending = i > current;

          return (
            <React.Fragment key={step.id}>
              <li className="flex items-center gap-2">
                {/* Circle */}
                <span
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center shrink-0",
                    "text-xs font-semibold transition-all duration-200",
                    done    && "bg-brand-500 text-white",
                    active  && "bg-brand-500 text-white ring-4 ring-brand-500/20",
                    pending && "bg-surface-2 text-text-tertiary border border-border"
                  )}
                >
                  {done ? (
                    <CheckIcon size={12} />
                  ) : (
                    <span>{i + 1}</span>
                  )}
                </span>
                <span
                  className={cn(
                    "text-sm whitespace-nowrap",
                    active  && "font-medium text-text-primary",
                    done    && "text-text-secondary",
                    pending && "text-text-tertiary"
                  )}
                >
                  {step.label}
                </span>
              </li>

              {/* Connector */}
              {i < steps.length - 1 && (
                <div
                  className={cn(
                    "h-px flex-1 mx-3 transition-colors duration-500",
                    i < current ? "bg-brand-500" : "bg-border"
                  )}
                />
              )}
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
}


// ── Stat card ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string | number;
  delta?: string;
  deltaPositive?: boolean;
  icon?: React.ReactNode;
  className?: string;
}

export function StatCard({ label, value, delta, deltaPositive, icon, className }: StatCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-surface-1 px-5 py-4 flex items-start gap-3",
        className
      )}
    >
      {icon && (
        <div className="w-9 h-9 rounded-lg bg-surface-2 border border-border flex items-center justify-center text-text-secondary shrink-0">
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-xs text-text-tertiary font-medium uppercase tracking-wider">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
        {delta && (
          <p
            className={cn(
              "mt-0.5 text-xs font-medium",
              deltaPositive ? "text-success" : "text-danger"
            )}
          >
            {deltaPositive ? "↑" : "↓"} {delta}
          </p>
        )}
      </div>
    </div>
  );
}


// ── Video thumbnail card ───────────────────────────────────────────────────────

import { StatusBadge } from "./StatusBadge";
import { formatDuration, relativeTime } from "@/lib/utils";

interface VideoCardProps {
  id: string;
  title: string;
  thumbnailUrl?: string;
  status: string;
  duration?: number;
  createdAt: string;
  onClick?: () => void;
}

export function VideoCard({ title, thumbnailUrl, status, duration, createdAt, onClick }: VideoCardProps) {
  return (
    <article
      onClick={onClick}
      className="group rounded-xl border border-border bg-surface-1 overflow-hidden cursor-pointer hover:border-brand-500/40 hover:shadow-elevation-2 transition-all duration-200"
    >
      {/* Thumbnail */}
      <div className="relative aspect-[9/16] bg-surface-2 overflow-hidden w-full max-h-48">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-text-tertiary">
            <VideoPlaceholderIcon />
          </div>
        )}
        {/* Duration badge */}
        {duration && (
          <span className="absolute bottom-2 right-2 text-xs font-medium bg-surface-0/90 backdrop-blur-sm text-text-primary px-1.5 py-0.5 rounded-md tabular-nums">
            {formatDuration(duration)}
          </span>
        )}
      </div>

      {/* Meta */}
      <div className="px-3 py-2.5 flex flex-col gap-1.5">
        <p className="text-sm font-medium text-text-primary line-clamp-1 group-hover:text-brand-400 transition-colors">
          {title}
        </p>
        <div className="flex items-center justify-between">
          <StatusBadge status={status as any} />
          <span className="text-xs text-text-tertiary">{relativeTime(createdAt)}</span>
        </div>
      </div>
    </article>
  );
}


// ── Inline SVGs (no external deps) ────────────────────────────────────────────

function CheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function VideoPlaceholderIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="3" />
      <path d="M10 8l6 4-6 4V8z" />
    </svg>
  );
}

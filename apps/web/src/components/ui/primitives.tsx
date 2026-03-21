import * as React from "react";
import { cn } from "@/lib/utils";

// ── Button ────────────────────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type ButtonSize    = "xs" | "sm" | "md" | "lg";

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700 shadow-sm",
  secondary:
    "bg-surface-2 text-text-primary hover:bg-surface-3 active:bg-surface-3/80",
  ghost:
    "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
  danger:
    "bg-danger text-white hover:bg-red-600 active:bg-red-700",
  outline:
    "border border-border text-text-primary hover:bg-surface-2",
};

const buttonSizes: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-xs gap-1",
  sm: "h-7 px-2.5 text-sm gap-1.5",
  md: "h-8 px-3 text-sm gap-2",
  lg: "h-10 px-4 text-base gap-2",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "secondary",
      size = "md",
      loading = false,
      icon,
      iconRight,
      className,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center font-medium rounded-md",
          "transition-colors duration-150 cursor-pointer select-none",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface-0",
          buttonVariants[variant],
          buttonSizes[size],
          className
        )}
        {...props}
      >
        {loading ? (
          <LoadingSpinner size={size === "lg" ? 16 : 14} />
        ) : (
          icon && <span className="shrink-0">{icon}</span>
        )}
        {children}
        {!loading && iconRight && <span className="shrink-0">{iconRight}</span>}
      </button>
    );
  }
);
Button.displayName = "Button";


// ── Badge ─────────────────────────────────────────────────────────────────────

type BadgeVariant = "default" | "success" | "warning" | "danger" | "info" | "outline" | "brand";

const badgeVariants: Record<BadgeVariant, string> = {
  default:  "bg-surface-2 text-text-secondary",
  success:  "bg-success/10 text-success",
  warning:  "bg-warning/10 text-warning",
  danger:   "bg-danger/10 text-danger",
  info:     "bg-info/10 text-info",
  brand:    "bg-brand-500/10 text-brand-400",
  outline:  "border border-border text-text-secondary",
};

interface BadgeProps {
  variant?: BadgeVariant;
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Badge({ variant = "default", dot = false, className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium",
        badgeVariants[variant],
        className
      )}
    >
      {dot && (
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            variant === "success" && "bg-success animate-pulse-dot",
            variant === "warning" && "bg-warning",
            variant === "danger"  && "bg-danger",
            variant === "info"    && "bg-info",
            variant === "brand"   && "bg-brand-400",
            (variant === "default" || variant === "outline") && "bg-text-tertiary"
          )}
        />
      )}
      {children}
    </span>
  );
}


// ── Card ──────────────────────────────────────────────────────────────────────

interface CardProps {
  className?: string;
  children: React.ReactNode;
  onClick?: () => void;
  hoverable?: boolean;
}

export function Card({ className, children, onClick, hoverable = false }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "rounded-xl border border-border bg-surface-1",
        hoverable && "cursor-pointer hover:border-brand-500/40 hover:shadow-elevation-2 transition-all duration-200",
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-5 py-4 border-b border-border", className)}>{children}</div>;
}

export function CardContent({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

export function CardFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-5 py-3 border-t border-border bg-surface-0 rounded-b-xl", className)}>{children}</div>;
}


// ── Input ─────────────────────────────────────────────────────────────────────

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, error, iconLeft, iconRight, className, id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
            {label}
          </label>
        )}
        <div className="relative flex items-center">
          {iconLeft && (
            <span className="absolute left-2.5 text-text-tertiary pointer-events-none">{iconLeft}</span>
          )}
          <input
            ref={ref}
            id={inputId}
            className={cn(
              "w-full h-8 rounded-md border border-border bg-surface-1 px-3 text-sm text-text-primary",
              "placeholder:text-text-tertiary",
              "transition-colors duration-150",
              "hover:border-border/80 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
              "outline-none disabled:opacity-50 disabled:cursor-not-allowed",
              iconLeft && "pl-8",
              iconRight && "pr-8",
              error && "border-danger focus:border-danger focus:ring-danger/20",
              className
            )}
            {...props}
          />
          {iconRight && (
            <span className="absolute right-2.5 text-text-tertiary pointer-events-none">{iconRight}</span>
          )}
        </div>
        {(hint || error) && (
          <p className={cn("text-xs", error ? "text-danger" : "text-text-tertiary")}>
            {error ?? hint}
          </p>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";


// ── Textarea ──────────────────────────────────────────────────────────────────

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, hint, error, className, id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          className={cn(
            "w-full min-h-[80px] rounded-md border border-border bg-surface-1 px-3 py-2",
            "text-sm text-text-primary placeholder:text-text-tertiary",
            "resize-y transition-colors duration-150",
            "hover:border-border/80 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
            "outline-none disabled:opacity-50",
            error && "border-danger focus:border-danger focus:ring-danger/20",
            className
          )}
          {...props}
        />
        {(hint || error) && (
          <p className={cn("text-xs", error ? "text-danger" : "text-text-tertiary")}>
            {error ?? hint}
          </p>
        )}
      </div>
    );
  }
);
Textarea.displayName = "Textarea";


// ── Progress ──────────────────────────────────────────────────────────────────

interface ProgressProps {
  value: number;          // 0–100
  max?: number;
  size?: "sm" | "md";
  variant?: "brand" | "success" | "warning" | "danger";
  showLabel?: boolean;
  className?: string;
}

const progressColors: Record<string, string> = {
  brand:   "bg-brand-500",
  success: "bg-success",
  warning: "bg-warning",
  danger:  "bg-danger",
};

export function Progress({
  value,
  max = 100,
  size = "md",
  variant = "brand",
  showLabel = false,
  className,
}: ProgressProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemax={max}
        className={cn(
          "flex-1 rounded-full bg-surface-3 overflow-hidden",
          size === "sm" ? "h-1" : "h-1.5"
        )}
      >
        <div
          className={cn("h-full rounded-full transition-all duration-500", progressColors[variant])}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className="text-xs tabular-nums text-text-tertiary w-8 text-right">
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}


// ── Divider ───────────────────────────────────────────────────────────────────

export function Divider({ className }: { className?: string }) {
  return <div className={cn("h-px bg-border", className)} />;
}


// ── Loading Spinner ───────────────────────────────────────────────────────────

export function LoadingSpinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={cn("animate-spin text-current", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-label="Загрузка"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-80"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}


// ── Skeleton ──────────────────────────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} />;
}


// ── Empty state ───────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      {icon && (
        <div className="w-12 h-12 rounded-xl bg-surface-2 border border-border flex items-center justify-center text-text-tertiary">
          {icon}
        </div>
      )}
      <div>
        <p className="text-sm font-medium text-text-primary">{title}</p>
        {description && <p className="mt-0.5 text-sm text-text-tertiary">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// Status badge for video jobs — maps JobStatus/VideoStatus strings to Badge variants
import { Badge } from "./primitives";

type Status =
  | "draft" | "pending" | "processing" | "composing"
  | "completed" | "failed" | "cancelled" | "running"
  | "scenes_ready"
  // Uniquify / SourceVideo
  | "analyzing" | "generating" | "ready" | "rendering" | "tts"
  // Distribute / Publish
  | "scheduled" | "publishing" | "published" | "skipped" | "distributing" | "uploading";

const STATUS_MAP: Record<
  Status,
  { label: string; variant: Parameters<typeof Badge>[0]["variant"]; dot?: boolean }
> = {
  pending:      { label: "Queued",      variant: "warning",  dot: true  },
  running:      { label: "Running",     variant: "info",     dot: true  },
  processing:   { label: "Processing",  variant: "info",     dot: true  },
  scenes_ready: { label: "Scenes ready",variant: "info",     dot: true  },
  composing:    { label: "Composing",    variant: "brand",    dot: true  },
  completed:    { label: "Completed",    variant: "success",  dot: false },
  failed:       { label: "Failed",       variant: "danger",   dot: false },
  cancelled:    { label: "Cancelled",    variant: "outline",  dot: false },
  draft:        { label: "Draft",        variant: "default",  dot: false },
  // Uniquify / SourceVideo
  analyzing:    { label: "Analyzing",    variant: "info",     dot: true  },
  generating:   { label: "Generating",   variant: "brand",    dot: true  },
  ready:        { label: "Ready",        variant: "success",  dot: false },
  rendering:    { label: "Rendering",    variant: "info",     dot: true  },
  tts:          { label: "TTS",          variant: "info",     dot: true  },
  // Distribute / Publish
  scheduled:    { label: "Scheduled",    variant: "warning",  dot: false },
  publishing:   { label: "Publishing",   variant: "brand",    dot: true  },
  published:    { label: "Published",    variant: "success",  dot: false },
  skipped:      { label: "Skipped",      variant: "outline",  dot: false },
  distributing: { label: "Distributing", variant: "brand",    dot: true  },
  uploading:    { label: "Uploading",    variant: "info",     dot: true  },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const cfg = STATUS_MAP[status as Status] ?? { label: status, variant: "default" as const };
  return (
    <Badge variant={cfg.variant} dot={cfg.dot} className={className}>
      {cfg.label}
    </Badge>
  );
}

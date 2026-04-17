// Status badge for video jobs — maps JobStatus/VideoStatus strings to Badge variants
import { Badge } from "./primitives";

type Status =
  | "draft" | "pending" | "processing" | "composing"
  | "completed" | "failed" | "cancelled" | "running"
  | "scenes_ready";

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
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_MAP[status as Status] ?? { label: status, variant: "default" as const };
  return (
    <Badge variant={cfg.variant} dot={cfg.dot}>
      {cfg.label}
    </Badge>
  );
}

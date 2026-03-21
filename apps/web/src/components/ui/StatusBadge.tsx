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
  draft:        { label: "Черновик",    variant: "default",  dot: false },
  pending:      { label: "В очереди",   variant: "warning",  dot: true  },
  running:      { label: "Запущен",     variant: "info",     dot: true  },
  processing:   { label: "Обработка",   variant: "info",     dot: true  },
  scenes_ready: { label: "Сцены готовы",variant: "info",     dot: true  },
  composing:    { label: "Монтаж",      variant: "brand",    dot: true  },
  completed:    { label: "Готово",      variant: "success",  dot: false },
  failed:       { label: "Ошибка",      variant: "danger",   dot: false },
  cancelled:    { label: "Отменено",    variant: "outline",  dot: false },
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_MAP[status as Status] ?? { label: status, variant: "default" as const };
  return (
    <Badge variant={cfg.variant} dot={cfg.dot}>
      {cfg.label}
    </Badge>
  );
}

import { Badge } from "@/components/ui/primitives";
import type { AutopilotBatchStatus, AutopilotStatus } from "@/lib/api";

const STATUS: Record<AutopilotStatus, { label: string; variant: Parameters<typeof Badge>[0]["variant"]; dot?: boolean }> = {
  draft: { label: "Черновик", variant: "default" },
  active: { label: "Работает", variant: "success", dot: true },
  paused: { label: "Пауза", variant: "warning" },
  error: { label: "Остановлен", variant: "danger" },
};

export function AutopilotStatusBadge({ status }: { status: AutopilotStatus }) {
  const s = STATUS[status] ?? { label: status, variant: "default" as const };
  return <Badge variant={s.variant} dot={s.dot}>{s.label}</Badge>;
}

/** Ordered production stages shown in the batch stepper. */
export const BATCH_STAGES: { id: AutopilotBatchStatus; label: string }[] = [
  { id: "scripting", label: "Сценарий" },
  { id: "analyzing", label: "Раскадровка" },
  { id: "rendering", label: "Рендер" },
  { id: "uniquifying", label: "Уникализация" },
  { id: "ready", label: "Готово" },
];

export function stageIndex(status: AutopilotBatchStatus): number {
  if (status === "pending") return 0;
  if (status === "failed") return -1;
  return BATCH_STAGES.findIndex((s) => s.id === status);
}

/** "сегодня 14:07 (через 2 ч)" in the autopilot's timezone. */
export function formatWindow(iso: string, tz: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const dayKey = (x: Date) => x.toLocaleDateString("ru-RU", { timeZone: tz });
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const day = dayKey(d) === dayKey(now) ? "сегодня" : dayKey(d) === dayKey(tomorrow) ? "завтра" : dayKey(d);
  const mins = Math.round((d.getTime() - now.getTime()) / 60_000);
  const rel = mins <= 0 ? "сейчас" : mins < 60 ? `через ${mins} мин` : `через ${Math.floor(mins / 60)} ч ${mins % 60} мин`;
  return `${day} ${time} (${rel})`;
}

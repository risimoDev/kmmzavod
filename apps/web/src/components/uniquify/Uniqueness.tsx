/**
 * Uniqueness readouts for uniquify variants: score badge, measured distances
 * and a human summary of what was changed (recipe).
 */
import { cn } from "@/lib/utils";
import type { UniqueVariant, VariantTransforms } from "@/lib/api";

export function scoreTone(score: number | null | undefined): string {
  if (score == null) return "bg-surface-2 text-text-tertiary";
  if (score >= 60) return "bg-success/15 text-success";
  if (score >= 35) return "bg-warning/15 text-warning";
  return "bg-danger/15 text-danger";
}

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** Short list of the levers applied to this copy. */
export function recipeChips(t: VariantTransforms | null | undefined): string[] {
  const r = t?.recipe;
  if (!r) return [];
  const out: string[] = [];
  if (r.montage_segments) out.push(`${r.montage_segments} кадров`);
  if (r.zoom && r.zoom > 1.001) out.push(`кадр +${Math.round((r.zoom - 1) * 100)}%`);
  if (r.rotate_deg) out.push(`поворот ${r.rotate_deg > 0 ? "+" : ""}${r.rotate_deg}°`);
  if (r.speed && Math.abs(r.speed - 1) > 0.002) out.push(`скорость ×${r.speed.toFixed(3)}`);
  if (r.pitch_semitones) out.push(`тон ${r.pitch_semitones > 0 ? "+" : ""}${r.pitch_semitones}`);
  if (r.hue_deg) out.push(`оттенок ${r.hue_deg > 0 ? "+" : ""}${r.hue_deg}°`);
  if (r.frame_layout) out.push("рамка");
  if (r.mirror) out.push("зеркало");
  if (r.model) out.push(r.model);
  return out;
}

export function UniquenessBadge({ variant }: { variant: UniqueVariant }) {
  const u = variant.transforms?.uniqueness;
  if (!u || (u.score == null && !u.vs_source)) return null;
  const title = [
    u.vs_source ? `От исходника: картинка ${pct(u.vs_source.visual)}, звук ${pct(u.vs_source.audio)}` : "",
    u.nearest_sibling ? `От ближайшей копии: картинка ${pct(u.nearest_sibling.visual)}, звук ${pct(u.nearest_sibling.audio)}` : "",
    u.reason ? `⚠ ${u.reason} — автопилот её не опубликует` : "",
  ].filter(Boolean).join("\n");
  return (
    <span title={title}
      className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-semibold", scoreTone(u.score))}>
      {u.ok === false ? "⚠ " : ""}уникальность {u.score ?? "—"}
    </span>
  );
}

export function UniquenessDetails({ variant }: { variant: UniqueVariant }) {
  const u = variant.transforms?.uniqueness;
  const chips = recipeChips(variant.transforms);
  if (!u && !chips.length) return null;
  return (
    <div className="space-y-1">
      {u?.vs_source && (
        <p className="text-2xs text-text-tertiary">
          от исходника: картинка <b className="text-text-secondary">{pct(u.vs_source.visual)}</b>, звук <b className="text-text-secondary">{pct(u.vs_source.audio)}</b>
          {u.nearest_sibling && <> · от соседней копии: {pct(u.nearest_sibling.visual)} / {pct(u.nearest_sibling.audio)}</>}
        </p>
      )}
      {u?.reason && <p className="text-2xs text-danger">⚠ {u.reason} — не будет опубликована автопилотом</p>}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((c) => <span key={c} className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-text-tertiary">{c}</span>)}
        </div>
      )}
    </div>
  );
}

/** Job-level summary: average score and how many copies are weak. */
export function UniquenessSummary({ variants }: { variants: UniqueVariant[] }) {
  const scored = variants.map((v) => v.transforms?.uniqueness).filter((u): u is NonNullable<typeof u> => u?.score != null);
  if (!scored.length) return null;
  const avg = Math.round(scored.reduce((t, u) => t + (u.score ?? 0), 0) / scored.length);
  const min = Math.min(...scored.map((u) => u.score ?? 0));
  const weak = scored.filter((u) => u.ok === false).length;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={cn("rounded px-2 py-0.5 font-semibold", scoreTone(avg))}>Средняя уникальность {avg}</span>
      <span className="text-text-tertiary">минимум {min}</span>
      {weak > 0
        ? <span className="text-danger">⚠ слабых копий: {weak} (не публикуются автопилотом)</span>
        : <span className="text-success">все копии достаточно отличаются</span>}
    </div>
  );
}

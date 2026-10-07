/**
 * Editor products — what the user is making. The server maps a product to the
 * engine's mode/geometry (see apps/api editor.routes.ts); the UI uses this
 * catalogue for the wizard, badges and product-specific controls.
 */
import type { EditPace, EditProduct, EditProject } from "@/lib/api";

export const PRODUCTS: { value: EditProduct; label: string; hint: string; icon: string }[] = [
  { value: "uniquify_one", icon: "✂️", label: "Под уникализацию · из одного видео",
    hint: "Несколько разных перемонтажей одного ролика — каждый станет основой для уникальных копий" },
  { value: "uniquify_multi", icon: "🎛️", label: "Под уникализацию · из нескольких видео",
    hint: "Разные миксы из лучших кадров нескольких роликов — максимум различий между копиями" },
  { value: "smart_montage", icon: "🎬", label: "Готовый ролик",
    hint: "Хайлайты или микс с субтитрами по речи, AI-сценарием и озвучкой" },
];

export const PACES: { value: EditPace; label: string; hint: string }[] = [
  { value: "calm", label: "Спокойный", hint: "2.5–5с кадр" },
  { value: "normal", label: "Обычный", hint: "1.6–3.6с" },
  { value: "fast", label: "Динамичный", hint: "1–2.4с" },
];

export function productOf(p: Pick<EditProject, "mode" | "config">): EditProduct {
  const v = (p.config as Record<string, unknown> | null | undefined)?.product;
  if (v === "uniquify_one" || v === "uniquify_multi" || v === "smart_montage") return v;
  return p.mode === "uniquify_source" ? "uniquify_multi" : "smart_montage";
}

export function productIcon(p: Pick<EditProject, "mode" | "config">): string {
  return PRODUCTS.find((x) => x.value === productOf(p))?.icon ?? "🎬";
}

export function productLabel(p: Pick<EditProject, "mode" | "config" | "geometry">): string {
  const pr = productOf(p);
  if (pr === "uniquify_one") return "уник. · 1 видео";
  if (pr === "uniquify_multi") return "уник. · N видео";
  return p.geometry === "highlights" ? "хайлайты" : "микс";
}

/** Montage options stored in EditProject.config. */
export function montageOptions(p: Pick<EditProject, "config">) {
  const c = (p.config ?? {}) as Record<string, unknown>;
  const pace = (["calm", "normal", "fast"] as const).includes(c.pace as EditPace) ? (c.pace as EditPace) : "normal";
  return {
    variantCount: typeof c.variantCount === "number" ? c.variantCount : 1,
    pace,
    hookFirst: c.hookFirst !== false,
    uniquifyJobIds: Array.isArray(c.uniquifyJobIds) ? (c.uniquifyJobIds as string[]) : [],
  };
}

"use client";

/**
 * Voice rotation picker for the autopilot: catalogue voices + the tenant's own voice
 * library (hand-typed Fish Audio ids, saved on the server and offered again next time).
 * Selected voices are used in turn, one per montage, in the order shown.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { autopilotApi, editorApi, type FishAudioVoice, type TenantVoice } from "@/lib/api";

const VOICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const GENDER_ICON: Record<TenantVoice["gender"], string> = { male: "♂", female: "♀", unknown: "?" };
const GENDER_NEXT: Record<TenantVoice["gender"], TenantVoice["gender"]> = { unknown: "male", male: "female", female: "unknown" };

/** Ids from free text: plain ids and fish.audio links, separated by spaces/commas/new lines. */
export function parseVoiceIds(raw: string): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const token of raw.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)) {
    const fromUrl = /fish\.audio\/(?:[a-z-]{2,5}\/)?m\/([A-Za-z0-9_-]{8,64})/i.exec(token)?.[1];
    const id = fromUrl ?? token;
    if (VOICE_ID_RE.test(id)) { if (!ids.includes(id)) ids.push(id); } else invalid.push(token);
  }
  return { ids, invalid };
}

const chip = "rounded-lg px-3 py-1.5 text-xs font-medium transition-all text-left";
const chipOn = "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/40";
const chipOff = "bg-surface-2 text-text-secondary hover:text-text-primary hover:bg-surface-3";
const iconBtn = "rounded px-1.5 py-0.5 text-2xs text-text-tertiary hover:text-text-primary hover:bg-surface-3 disabled:opacity-40";
const inputCls =
  "w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500";

export function VoicePicker({
  value, onChange, presets, library, onLibraryChange, speed,
}: {
  value: string[];
  /** Functional updates: several changes can land before the next render (async adds, quick clicks). */
  onChange: (update: (prev: string[]) => string[]) => void;
  presets: FishAudioVoice[];
  library: TenantVoice[];
  onLibraryChange: (lib: TenantVoice[]) => void;
  speed: number;
}) {
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("");
  const [gender, setGender] = useState<TenantVoice["gender"]>("unknown");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const labelOf = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (p) return { name: p.name, gender: p.gender };
    const l = library.find((x) => x.voiceId === id);
    if (l) return { name: l.name, gender: l.gender };
    return { name: `Голос ${id.slice(0, 8)}`, gender: "unknown" as const };
  };

  const toggle = (id: string) => onChange((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const move = (id: string, dir: -1 | 1) => onChange((prev) => {
    const i = prev.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const upsertLocal = (voice: TenantVoice, lib: TenantVoice[]) =>
    lib.some((x) => x.voiceId === voice.voiceId) ? lib.map((x) => (x.voiceId === voice.voiceId ? voice : x)) : [...lib, voice];

  const add = async () => {
    const { ids, invalid } = parseVoiceIds(raw);
    if (!ids.length) {
      setNotice({ kind: "error", text: invalid.length ? `Не похоже на ID голоса: ${invalid.join(", ")}` : "Вставьте ID голоса Fish Audio или ссылку fish.audio/m/…" });
      return;
    }
    setAdding(true);
    setNotice(null);
    let lib = library;
    const selected: string[] = [];
    const errors: string[] = [];
    const warnings = new Set<string>();
    for (const id of ids) {
      if (presets.some((p) => p.id === id)) {
        if (!selected.includes(id)) selected.push(id);
        continue;
      }
      try {
        const res = await autopilotApi.saveVoice({
          voiceId: id,
          ...(ids.length === 1 && name.trim() ? { name: name.trim() } : {}),
          ...(gender !== "unknown" ? { gender } : {}),
        });
        lib = upsertLocal(res.voice, lib);
        if (!selected.includes(id)) selected.push(id);
        if (res.warning) warnings.add(res.warning);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    onLibraryChange(lib);
    onChange((prev) => [...prev, ...selected.filter((id) => !prev.includes(id))]);
    setAdding(false);
    if (errors.length) setNotice({ kind: "error", text: errors.join(" · ") });
    else if (warnings.size) setNotice({ kind: "warn", text: [...warnings].join(" · ") });
    else setNotice({ kind: "ok", text: ids.length > 1 ? `Добавлено голосов: ${ids.length}` : "Голос сохранён и добавлен в ротацию" });
    if (!errors.length) { setRaw(""); setName(""); setGender("unknown"); }
    if (invalid.length) setNotice((n) => ({ kind: "warn", text: `${n?.text ? `${n.text} · ` : ""}Пропущено (неверный формат): ${invalid.join(", ")}` }));
  };

  const cycleGender = async (v: TenantVoice) => {
    const nextGender = GENDER_NEXT[v.gender];
    onLibraryChange(upsertLocal({ ...v, gender: nextGender }, library));
    try {
      await autopilotApi.saveVoice({ voiceId: v.voiceId, gender: nextGender });
    } catch (e) {
      onLibraryChange(upsertLocal(v, library));
      setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const remove = async (v: TenantVoice) => {
    if (!window.confirm(`Удалить «${v.name}» из библиотеки голосов?`)) return;
    try {
      await autopilotApi.deleteVoice(v.voiceId);
      onLibraryChange(library.filter((x) => x.voiceId !== v.voiceId));
      onChange((prev) => prev.filter((x) => x !== v.voiceId));
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const preview = async (id: string) => {
    audioRef.current?.pause();
    if (playing === id) { setPlaying(null); return; }
    setPlaying(id);
    try {
      const { audioUrl } = await editorApi.voicePreview(id, speed);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      audio.onended = () => setPlaying((p) => (p === id ? null : p));
      await audio.play();
    } catch (e) {
      setPlaying(null);
      setNotice({ kind: "error", text: `Прослушивание: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const PlayBtn = ({ id }: { id: string }) => (
    <button type="button" className={iconBtn} title="Прослушать"
      onClick={(e) => { e.stopPropagation(); void preview(id); }}>
      {playing === id ? "■" : "▶"}
    </button>
  );

  return (
    <div className="space-y-3">
      {/* Rotation order */}
      <div className="rounded-lg border border-border bg-surface-1 p-2">
        {value.length === 0 ? (
          <p className="px-1 py-1 text-2xs text-text-tertiary">
            Ничего не выбрано — будет голос по умолчанию ({presets[0]?.name ?? "встроенный"}).
          </p>
        ) : (
          <ol className="flex flex-wrap gap-1.5">
            {value.map((id, i) => {
              const l = labelOf(id);
              return (
                <li key={id} className={cn(chip, chipOn, "flex items-center gap-1 py-1")}>
                  <span className="font-mono text-2xs opacity-60">{i + 1}.</span>
                  <span>{GENDER_ICON[l.gender]}</span>
                  <span className="max-w-[12rem] truncate" title={id}>{l.name}</span>
                  <button type="button" className={iconBtn} title="Раньше" disabled={i === 0} onClick={() => move(id, -1)}>←</button>
                  <button type="button" className={iconBtn} title="Позже" disabled={i === value.length - 1} onClick={() => move(id, 1)}>→</button>
                  <button type="button" className={iconBtn} title="Убрать из ротации" onClick={() => toggle(id)}>✕</button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Catalogue */}
      <div className="grid gap-2 sm:grid-cols-2">
        {presets.map((voice) => (
          <div key={voice.id} role="button" tabIndex={0}
            onClick={() => toggle(voice.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(voice.id); } }}
            className={cn(chip, value.includes(voice.id) ? chipOn : chipOff, "cursor-pointer")}>
            <div className="flex items-center gap-1.5">
              <span>{voice.gender === "female" ? "♀" : "♂"}</span>
              <span className="flex-1">{voice.name}</span>
              <PlayBtn id={voice.id} />
            </div>
            <div className="text-2xs font-normal text-text-tertiary line-clamp-1">{voice.description}</div>
          </div>
        ))}
      </div>

      {/* Tenant library */}
      {library.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-2xs font-medium uppercase tracking-wide text-text-tertiary">Мои голоса</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {library.map((v) => (
              <div key={v.voiceId} role="button" tabIndex={0}
                onClick={() => toggle(v.voiceId)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(v.voiceId); } }}
                className={cn(chip, value.includes(v.voiceId) ? chipOn : chipOff, "cursor-pointer")}>
                <div className="flex items-center gap-1.5">
                  <button type="button" className={iconBtn}
                    title="Пол диктора (для рода в сценарии): нажмите, чтобы сменить"
                    onClick={(e) => { e.stopPropagation(); void cycleGender(v); }}>
                    {GENDER_ICON[v.gender]}
                  </button>
                  <span className="flex-1 truncate">{v.name}</span>
                  <PlayBtn id={v.voiceId} />
                  <button type="button" className={iconBtn} title="Удалить из библиотеки"
                    onClick={(e) => { e.stopPropagation(); void remove(v); }}>🗑</button>
                </div>
                <div className="font-mono text-2xs font-normal text-text-tertiary truncate">{v.voiceId}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add by id */}
      <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
        <div className="text-2xs font-medium text-text-secondary">Свой голос по ID Fish Audio</div>
        <textarea
          className={cn(inputCls, "min-h-[2.5rem] font-mono text-xs")}
          rows={2}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void add(); } }}
          placeholder="ID или ссылки fish.audio/m/… — можно несколько через пробел, запятую или с новой строки"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input className={cn(inputCls, "flex-1 min-w-[10rem]")} value={name} onChange={(e) => setName(e.target.value)}
            placeholder={parseVoiceIds(raw).ids.length > 1 ? "Названия возьмём из Fish Audio" : "Название (необязательно)"}
            disabled={parseVoiceIds(raw).ids.length > 1} />
          <select className={cn(inputCls, "w-auto")} value={gender} onChange={(e) => setGender(e.target.value as TenantVoice["gender"])}
            title="Пол диктора — для рода в сценарии">
            <option value="unknown">Пол: ?</option>
            <option value="male">♂ Мужской</option>
            <option value="female">♀ Женский</option>
          </select>
          <button type="button" onClick={() => void add()} disabled={adding || !raw.trim()}
            className="rounded-lg bg-brand-500 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {adding ? "Проверяем…" : "Добавить в ротацию"}
          </button>
        </div>
        {notice && (
          <p className={cn("text-2xs",
            notice.kind === "error" ? "text-danger" : notice.kind === "warn" ? "text-warning" : "text-success")}>
            {notice.text}
          </p>
        )}
      </div>
    </div>
  );
}

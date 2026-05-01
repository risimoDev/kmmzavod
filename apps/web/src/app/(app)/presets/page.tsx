"use client";

import { useState, useEffect, useCallback } from "react";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  CardContent,
  Input,
  Badge,
  LoadingSpinner,
  EmptyState,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { presetsApi, socialAccountsApi, productsApi, type VideoPreset, type SocialAccount, type Product } from "@/lib/api";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

const STATUS_LABELS: Record<VideoPreset["status"], string> = {
  draft: "Черновик",
  preview: "Превью",
  active: "Активна",
  paused: "Пауза",
};

const STATUS_COLORS: Record<VideoPreset["status"], string> = {
  draft: "bg-gray-100 text-gray-700",
  preview: "bg-blue-100 text-blue-700",
  active: "bg-green-100 text-green-700",
  paused: "bg-yellow-100 text-yellow-700",
};

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube_shorts: "YouTube Shorts",
  postbridge: "PostBridge",
};

interface ScheduleConfig {
  days: number[];
  hours: number[];
}

function cronFromSchedule(s: ScheduleConfig): string {
  const mins = "0";
  const hours = s.hours.length === 24 ? "*" : s.hours.join(",");
  const days = s.days.length === 7 ? "*" : s.days.map((d) => d + 1).join(",");
  return `${mins} ${hours} * * ${days}`;
}

function scheduleFromCron(cron: string | null): ScheduleConfig {
  if (!cron) return { days: [0, 2, 4], hours: [10, 18] };
  const parts = cron.split(" ");
  const hours = parts[1] === "*" ? Array.from({ length: 24 }, (_, i) => i) : parts[1].split(",").map(Number);
  const dayNums = parts[4] === "*" ? Array.from({ length: 7 }, (_, i) => i) : parts[4].split(",").map(Number).map((d: number) => d - 1);
  return { days: dayNums.filter((d: number) => d >= 0 && d < 7), hours };
}

export default function PresetsPage() {
  const [presets, setPresets] = useState<VideoPreset[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [socialAccounts, setSocialAccounts] = useState<SocialAccount[]>([]);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<VideoPreset | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    productId: "",
    editStyle: "random" as const,
    targetDurationSec: 30,
    customPrompt: "",
    autoPublish: false,
    publishPlatforms: [] as string[],
    socialAccountIds: [] as string[],
    bgmEnabled: true,
    schedule: { days: [0, 2, 4], hours: [10, 18] } as ScheduleConfig,
    timezone: "Europe/Moscow",
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [presetsRes, accountsRes, productsRes] = await Promise.all([
        presetsApi.list({ limit: 100 }),
        socialAccountsApi.list(),
        productsApi.list({ limit: 100 }),
      ]);
      setPresets(presetsRes.presets);
      setSocialAccounts(accountsRes as unknown as SocialAccount[]);
      setProducts(productsRes.data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const openCreate = () => {
    setForm({
      name: "",
      productId: products[0]?.id ?? "",
      editStyle: "random",
      targetDurationSec: 30,
      customPrompt: "",
      autoPublish: false,
      publishPlatforms: [],
      socialAccountIds: [],
      bgmEnabled: true,
      schedule: { days: [0, 2, 4], hours: [10, 18] },
      timezone: "Europe/Moscow",
    });
    setShowCreate(true);
  };

  const openEdit = (p: VideoPreset) => {
    const schedule = scheduleFromCron(p.cronExpression);
    setForm({
      name: p.name,
      productId: p.productId,
      editStyle: (p.editStyle as any) ?? "random",
      targetDurationSec: p.targetDurationSec,
      customPrompt: p.customPrompt ?? "",
      autoPublish: p.autoPublish,
      publishPlatforms: p.publishPlatforms ?? [],
      socialAccountIds: p.socialAccountIds ?? [],
      bgmEnabled: p.bgmEnabled,
      schedule,
      timezone: p.timezone,
    });
    setEditing(p);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name || undefined,
        productId: form.productId || undefined,
        editStyle: form.editStyle,
        targetDurationSec: form.targetDurationSec,
        customPrompt: form.customPrompt || undefined,
        cronExpression: cronFromSchedule(form.schedule),
        timezone: form.timezone,
        autoPublish: form.autoPublish,
        publishPlatforms: form.publishPlatforms,
        socialAccountIds: form.socialAccountIds,
        bgmEnabled: form.bgmEnabled,
      };
      if (editing) {
        await presetsApi.update(editing.id, payload);
      } else {
        await presetsApi.create(payload as any);
      }
      setShowCreate(false);
      setEditing(null);
      loadData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async (id: string) => {
    try {
      await presetsApi.activate(id);
      loadData();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handlePause = async (id: string) => {
    try {
      await presetsApi.pause(id);
      loadData();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handlePreview = async (id: string) => {
    try {
      await presetsApi.preview(id);
      loadData();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Удалить пресет?")) return;
    try {
      await presetsApi.delete(id);
      loadData();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const toggleDay = (day: number) => {
    const days = form.schedule.days.includes(day)
      ? form.schedule.days.filter((d) => d !== day)
      : [...form.schedule.days, day].sort();
    setForm({ ...form, schedule: { ...form.schedule, days } });
  };

  const toggleHour = (hour: number) => {
    const hours = form.schedule.hours.includes(hour)
      ? form.schedule.hours.filter((h) => h !== hour)
      : [...form.schedule.hours, hour].sort();
    setForm({ ...form, schedule: { ...form.schedule, hours } });
  };

  const togglePlatform = (platform: string) => {
    const platforms = form.publishPlatforms.includes(platform)
      ? form.publishPlatforms.filter((p) => p !== platform)
      : [...form.publishPlatforms, platform];
    setForm({ ...form, publishPlatforms: platforms });
  };

  const toggleSocialAccount = (id: string) => {
    const ids = form.socialAccountIds.includes(id)
      ? form.socialAccountIds.filter((i) => i !== id)
      : [...form.socialAccountIds, id];
    setForm({ ...form, socialAccountIds: ids });
  };

  const showModal = showCreate || editing;

  if (loading) return <LoadingSpinner className="mt-20" />;

  return (
    <div>
      <TopBar title="Фабрики видео" subtitle="Автогенерация и автопубликация по расписанию">
        <Button onClick={openCreate}>+ Новая фабрика</Button>
      </TopBar>

      {error && (
        <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4 text-sm">{error}</div>
      )}

      {presets.length === 0 ? (
        <EmptyState title="Нет фабрик" description="Создайте пресет-фабрику для автоматической генерации видео по расписанию" />
      ) : (
        <div className="grid gap-4">
          {presets.map((p) => (
            <Card key={p.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-lg">{p.name}</span>
                      <Badge className={STATUS_COLORS[p.status]}>{STATUS_LABELS[p.status]}</Badge>
                    </div>
                    <div className="text-sm text-gray-600 space-y-1">
                      <div>Продукт: {p.product?.name ?? "—"}</div>
                      <div>Стиль: {p.editStyle} · Длительность: {p.targetDurationSec}с</div>
                      <div>Расписание: {p.cronExpression ?? "не задано"} ({p.timezone})</div>
                      <div>Автопубликация: {p.autoPublish ? "да" : "нет"} {p.publishPlatforms.length > 0 ? `→ ${p.publishPlatforms.map((pl) => PLATFORM_LABELS[pl] ?? pl).join(", ")}` : ""}</div>
                      <div>Запусков: {p.totalRuns} {p.lastRunAt ? `· Последний: ${new Date(p.lastRunAt).toLocaleString("ru")}` : ""}</div>
                      {p.nextRunAt && p.status === "active" && (
                        <div>Следующий: {new Date(p.nextRunAt).toLocaleString("ru")}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-wrap justify-end">
                    {p.status === "draft" && (
                      <Button size="sm" variant="outline" onClick={() => handlePreview(p.id)}>Превью</Button>
                    )}
                    {(p.status === "draft" || p.status === "preview" || p.status === "paused") && (
                      <Button size="sm" onClick={() => handleActivate(p.id)}>Запустить</Button>
                    )}
                    {p.status === "active" && (
                      <Button size="sm" variant="outline" onClick={() => handlePause(p.id)}>Пауза</Button>
                    )}
                    {p.status !== "active" && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => openEdit(p)}>Настроить</Button>
                        <Button size="sm" variant="ghost" className="text-red-600" onClick={() => handleDelete(p.id)}>Удалить</Button>
                      </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => { setShowCreate(false); setEditing(null); }}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-bold mb-4">{editing ? "Настройка фабрики" : "Новая фабрика"}</h2>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Продукт</label>
                <select
                  className="w-full border rounded-lg p-2 text-sm"
                  value={form.productId}
                  onChange={(e) => setForm({ ...form, productId: e.target.value })}
                  disabled={!!editing}
                >
                  <option value="" disabled>Выберите продукт</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {editing && <p className="text-xs text-gray-500 mt-1">Продукт нельзя изменить у существующей фабрики</p>}
              </div>

              <div>
                <label className="text-sm font-medium text-gray-700">Название</label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Новый пресет" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">Стиль монтажа</label>
                  <select className="w-full border rounded-lg p-2 text-sm" value={form.editStyle} onChange={(e) => setForm({ ...form, editStyle: e.target.value as any })}>
                    <option value="random">Случайный</option>
                    <option value="dynamic">Динамичный</option>
                    <option value="smooth">Плавный</option>
                    <option value="minimal">Минимальный</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Длительность (сек)</label>
                  <Input type="number" min={15} max={90} value={form.targetDurationSec} onChange={(e) => setForm({ ...form, targetDurationSec: Number(e.target.value) })} />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-700">Дополнительный промпт (необязательно)</label>
                <textarea className="w-full border rounded-lg p-2 text-sm h-20 resize-none" value={form.customPrompt} onChange={(e) => setForm({ ...form, customPrompt: e.target.value })} placeholder="Укажите акценты, тон, особенности..." />
              </div>

              <div className="border-t pt-4">
                <h3 className="font-semibold mb-3">Расписание генерации</h3>
                <div className="mb-3">
                  <label className="text-sm font-medium text-gray-700 mb-2 block">Дни недели</label>
                  <div className="flex gap-2">
                    {WEEKDAYS.map((d, i) => (
                      <button
                        key={i}
                        onClick={() => toggleDay(i)}
                        className={cn(
                          "w-10 h-10 rounded-lg text-sm font-medium transition-colors",
                          form.schedule.days.includes(i) ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200",
                        )}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mb-3">
                  <label className="text-sm font-medium text-gray-700 mb-2 block">Часы публикации</label>
                  <div className="flex flex-wrap gap-1">
                    {HOURS.map((h) => (
                      <button
                        key={h}
                        onClick={() => toggleHour(h)}
                        className={cn(
                          "w-12 h-8 rounded text-xs font-medium transition-colors",
                          form.schedule.hours.includes(h) ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200",
                        )}
                      >
                        {String(h).padStart(2, "0")}:00
                      </button>
                    ))}
                  </div>
                </div>
                <div className="text-xs text-gray-500">
                  Cron: {cronFromSchedule(form.schedule)} · Часовой пояс: {form.timezone}
                </div>
              </div>

              <div className="border-t pt-4">
                <h3 className="font-semibold mb-3">Автопубликация</h3>
                <label className="flex items-center gap-2 mb-3 cursor-pointer">
                  <input type="checkbox" checked={form.autoPublish} onChange={(e) => setForm({ ...form, autoPublish: e.target.checked })} className="w-4 h-4" />
                  <span className="text-sm">Публиковать автоматически после генерации</span>
                </label>

                {form.autoPublish && (
                  <div className="space-y-3 pl-6">
                    <div>
                      <label className="text-sm font-medium text-gray-700 mb-2 block">Платформы</label>
                      <div className="flex gap-2 flex-wrap">
                        {Object.entries(PLATFORM_LABELS).map(([key, label]) => (
                          <button
                            key={key}
                            onClick={() => togglePlatform(key)}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                              form.publishPlatforms.includes(key) ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200",
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {socialAccounts.length > 0 && (
                      <div>
                        <label className="text-sm font-medium text-gray-700 mb-2 block">Аккаунты для публикации</label>
                        <div className="space-y-1">
                          {socialAccounts.filter((a) => a.isActive && form.publishPlatforms.includes(a.platform)).map((a) => (
                            <label key={a.id} className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={form.socialAccountIds.includes(a.id)}
                                onChange={() => toggleSocialAccount(a.id)}
                                className="w-4 h-4"
                              />
                              <span className="text-sm">{a.accountName} ({PLATFORM_LABELS[a.platform] ?? a.platform})</span>
                            </label>
                          ))}
                          {socialAccounts.filter((a) => a.isActive && form.publishPlatforms.includes(a.platform)).length === 0 && (
                            <div className="text-xs text-gray-500">Нет подключённых аккаунтов для выбранных платформ</div>
                          )}
                        </div>
                      </div>
                    )}

                    {socialAccounts.length === 0 && (
                      <div className="text-xs text-amber-600">
                        У вас нет подключённых соцсетей. Перейдите в Настройки, чтобы добавить аккаунты.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <Button onClick={handleSave} disabled={saving}>{saving ? "Сохранение..." : "Сохранить"}</Button>
              <Button variant="outline" onClick={() => { setShowCreate(false); setEditing(null); }}>Отмена</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

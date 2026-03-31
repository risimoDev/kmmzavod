"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Button, Badge, Card, CardContent } from "@/components/ui/primitives";
import { adminApi, type ServiceHealth, type ApiCheckResult } from "@/lib/admin-api";
import { cn } from "@/lib/utils";

type ComposePreset = 'dynamic' | 'smooth' | 'minimal';

const SERVICE_LABELS: Record<string, { label: string; description: string; noHeartbeat?: boolean }> = {
  api:                { label: "API",              description: "Fastify HTTP-сервер, аутентификация, маршруты" },
  orchestrator:       { label: "Оркестратор",      description: "BullMQ workers, AI-пайплайн, генерация видео" },
  "video-processor":  { label: "Видео-процессор",  description: "Python FFmpeg-сервис, композиция, субтитры", noHeartbeat: true },
};

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}с`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}м ${Math.floor(seconds % 60)}с`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}ч ${m}м`;
}

export default function AdminServicesPage() {
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});
  const [restartMsg, setRestartMsg] = useState<Record<string, string>>({});
  const [apiChecks, setApiChecks] = useState<ApiCheckResult[]>([]);
  const [apiChecking, setApiChecking] = useState(false);

  // Test compose state
  const [composePreset, setComposePreset] = useState<ComposePreset>('dynamic');
  const [composeSceneCount, setComposeSceneCount] = useState(3);
  const [composeDuration, setComposeDuration] = useState(4);
  const [composeSubtitles, setComposeSubtitles] = useState(true);
  const [composeRunning, setComposeRunning] = useState(false);
  const [composeResult, setComposeResult] = useState<{
    test_id: string;
    preset: string;
    compose_result: { output_key: string; duration_sec: number; file_size_bytes: number; width: number; height: number; scene_count: number };
    output_url: string;
    elapsed_ms: number;
  } | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await adminApi.getServicesHealth();
      setServices(res.services);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const timer = setInterval(fetchHealth, 10_000); // auto-refresh every 10s
    return () => clearInterval(timer);
  }, [fetchHealth]);

  const handleRestart = async (name: string) => {
    if (restarting[name]) return;
    setRestarting((p) => ({ ...p, [name]: true }));
    setRestartMsg((p) => ({ ...p, [name]: "" }));
    try {
      const res = await adminApi.restartService(name);
      setRestartMsg((p) => ({ ...p, [name]: res.message }));
      // Poll health after restart command
      setTimeout(fetchHealth, 3000);
      setTimeout(fetchHealth, 8000);
      setTimeout(fetchHealth, 15000);
    } catch (e: any) {
      setRestartMsg((p) => ({ ...p, [name]: `Ошибка: ${e.message}` }));
    } finally {
      setRestarting((p) => ({ ...p, [name]: false }));
    }
  };

  const handleRestartAll = async () => {
    if (restarting["all"]) return;
    setRestarting((p) => ({ ...p, all: true }));
    setRestartMsg((p) => ({ ...p, all: "" }));
    try {
      const res = await adminApi.restartService("all");
      setRestartMsg((p) => ({ ...p, all: res.message }));
      setTimeout(fetchHealth, 3000);
      setTimeout(fetchHealth, 8000);
      setTimeout(fetchHealth, 15000);
    } catch (e: any) {
      setRestartMsg((p) => ({ ...p, all: `Ошибка: ${e.message}` }));
    } finally {
      setRestarting((p) => ({ ...p, all: false }));
    }
  };

  const handleCheckApis = async () => {
    if (apiChecking) return;
    setApiChecking(true);
    try {
      const res = await adminApi.checkApis();
      setApiChecks(res.checks);
    } catch (e: any) {
      setApiChecks([{ name: 'error', status: 'error', latencyMs: 0, error: e.message }]);
    } finally {
      setApiChecking(false);
    }
  };

  const handleTestCompose = async () => {
    if (composeRunning) return;
    setComposeRunning(true);
    setComposeError(null);
    setComposeResult(null);
    try {
      const res = await adminApi.testCompose({
        preset: composePreset,
        scene_count: composeSceneCount,
        scene_duration: composeDuration,
        with_subtitles: composeSubtitles,
      });
      setComposeResult(res);
    } catch (e: any) {
      setComposeError(e.message);
    } finally {
      setComposeRunning(false);
    }
  };

  if (loading && services.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-text-tertiary text-sm">
        Загрузка статуса сервисов…
      </div>
    );
  }

  if (error && services.length === 0) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          Ошибка загрузки: {error}
          <Button variant="ghost" size="xs" className="ml-3" onClick={fetchHealth}>
            Повторить
          </Button>
        </div>
      </div>
    );
  }

  const onlineCount = services.filter((s) => s.status === "online").length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Управление сервисами</h1>
          <p className="text-xs text-text-tertiary mt-0.5">
            {onlineCount} из {services.length} онлайн · автообновление каждые 10с
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchHealth}>
            Обновить
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleRestartAll}
            disabled={restarting["all"]}
          >
            {restarting["all"] ? "Отправка…" : "Перезапустить все"}
          </Button>
        </div>
      </div>

      {restartMsg["all"] && (
        <div className="rounded-lg bg-brand-500/10 border border-brand-500/30 px-4 py-2 text-sm text-brand-400">
          {restartMsg["all"]}
        </div>
      )}

      {/* Service cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {services.map((svc) => {
          const meta = SERVICE_LABELS[svc.name] ?? { label: svc.name, description: "" };
          const isOnline = svc.status === "online";

          return (
            <motion.div key={svc.name} layout>
              <Card className={cn(
                "transition-all",
                !isOnline && !meta.noHeartbeat && "border-danger/30 bg-danger/5",
              )}>
                <CardContent className="p-5 space-y-4">
                  {/* Header row */}
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-text-primary">{meta.label}</h3>
                      <p className="text-xs text-text-tertiary mt-0.5">{meta.description}</p>
                    </div>
                    <Badge variant={isOnline ? "success" : meta.noHeartbeat ? "default" : "danger"} dot>
                      {isOnline ? "Онлайн" : meta.noHeartbeat ? "Нет данных" : "Офлайн"}
                    </Badge>
                  </div>

                  {/* Details */}
                  {isOnline && svc.details && (
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <span className="text-text-tertiary">PID</span>
                        <span className="text-text-secondary font-mono">{svc.details.pid}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-text-tertiary">Аптайм</span>
                        <span className="text-text-secondary">{formatUptime(svc.details.uptime)}</span>
                      </div>
                      {svc.details.workers != null && (
                        <div className="flex justify-between text-xs">
                          <span className="text-text-tertiary">Воркеров</span>
                          <span className="text-text-secondary">{svc.details.workers}</span>
                        </div>
                      )}
                      <div className="flex justify-between text-xs">
                        <span className="text-text-tertiary">Последний heartbeat</span>
                        <span className="text-text-secondary">
                          {new Date(svc.details.timestamp).toLocaleTimeString("ru-RU")}
                        </span>
                      </div>
                    </div>
                  )}

                  {!isOnline && meta.noHeartbeat && (
                    <p className="text-xs text-text-tertiary">
                      Heartbeat не реализован для этого сервиса. Статус определяется при вызове.
                    </p>
                  )}

                  {!isOnline && !meta.noHeartbeat && (
                    <p className="text-xs text-danger/80">
                      Сервис не отвечает. Heartbeat не поступает.
                    </p>
                  )}

                  {/* Restart button */}
                  <Button
                    variant={isOnline ? "outline" : "danger"}
                    size="sm"
                    className="w-full"
                    onClick={() => handleRestart(svc.name)}
                    disabled={restarting[svc.name]}
                  >
                    {restarting[svc.name] ? "Отправка команды…" : "Перезапустить"}
                  </Button>

                  {restartMsg[svc.name] && (
                    <p className="text-xs text-brand-400">{restartMsg[svc.name]}</p>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>

      {/* AI API Health Checks */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Проверка AI API</h2>
            <p className="text-xs text-text-tertiary mt-0.5">Тест доступности внешних сервисов</p>
          </div>
          <Button variant="outline" size="sm" onClick={handleCheckApis} disabled={apiChecking}>
            {apiChecking ? "Проверка…" : "Проверить все"}
          </Button>
        </div>

        {apiChecks.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {apiChecks.filter(c => c.name !== 'error').map((check) => {
              const labels: Record<string, { label: string; desc: string }> = {
                heygen:   { label: "HeyGen",   desc: "Генерация аватаров и озвучка" },
                runway:   { label: "Runway",   desc: "Генерация видеоклипов и изображений" },
                gptunnel: { label: "GPTunnel", desc: "GPT сценарии (OpenAI-совместимый)" },
              };
              const meta = labels[check.name] ?? { label: check.name, desc: "" };
              const isOk = check.status === "ok";

              return (
                <Card key={check.name} className={cn("transition-all", !isOk && "border-danger/30 bg-danger/5")}>
                  <CardContent className="p-5 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-text-primary">{meta.label}</h3>
                        <p className="text-xs text-text-tertiary mt-0.5">{meta.desc}</p>
                      </div>
                      <Badge variant={isOk ? "success" : "danger"} dot>
                        {isOk ? "OK" : "Ошибка"}
                      </Badge>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <span className="text-text-tertiary">Задержка</span>
                        <span className="text-text-secondary font-mono">{check.latencyMs}мс</span>
                      </div>
                      {check.info && (
                        <div className="flex justify-between text-xs">
                          <span className="text-text-tertiary">Инфо</span>
                          <span className="text-text-secondary">{check.info}</span>
                        </div>
                      )}
                      {check.error && (
                        <p className="text-xs text-danger/80 break-all">{check.error}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {apiChecks.find(c => c.name === 'error') && (
              <div className="col-span-full rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
                Ошибка запроса: {apiChecks.find(c => c.name === 'error')?.error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Test Video Composition */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Тест видео-композиции</h2>
            <p className="text-xs text-text-tertiary mt-0.5">
              Генерирует тестовые изображения и запускает FFmpeg-пайплайн
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestCompose}
            disabled={composeRunning}
          >
            {composeRunning ? "Обработка…" : "Запустить тест"}
          </Button>
        </div>

        {/* Settings row */}
        <div className="flex flex-wrap gap-4 items-end">
          <div className="space-y-1">
            <label className="text-xs text-text-tertiary">Пресет</label>
            <select
              className="block rounded-lg border border-border bg-surface-secondary px-3 py-1.5 text-xs text-text-primary"
              value={composePreset}
              onChange={(e) => setComposePreset(e.target.value as ComposePreset)}
              disabled={composeRunning}
            >
              <option value="dynamic">Динамичный (fade)</option>
              <option value="smooth">Плавный (dissolve)</option>
              <option value="minimal">Минимальный (cut)</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text-tertiary">Сцен</label>
            <select
              className="block rounded-lg border border-border bg-surface-secondary px-3 py-1.5 text-xs text-text-primary"
              value={composeSceneCount}
              onChange={(e) => setComposeSceneCount(Number(e.target.value))}
              disabled={composeRunning}
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text-tertiary">Длительность (с)</label>
            <select
              className="block rounded-lg border border-border bg-surface-secondary px-3 py-1.5 text-xs text-text-primary"
              value={composeDuration}
              onChange={(e) => setComposeDuration(Number(e.target.value))}
              disabled={composeRunning}
            >
              {[2, 3, 4, 5, 8, 10].map((n) => (
                <option key={n} value={n}>{n}с</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer pb-0.5">
            <input
              type="checkbox"
              checked={composeSubtitles}
              onChange={(e) => setComposeSubtitles(e.target.checked)}
              disabled={composeRunning}
              className="rounded"
            />
            Субтитры
          </label>
        </div>

        {composeRunning && (
          <div className="rounded-lg bg-brand-500/10 border border-brand-500/30 px-4 py-3 text-xs text-brand-400">
            Генерация тестовых изображений и рендеринг видео через FFmpeg… Это может занять до нескольких минут.
          </div>
        )}

        {composeError && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-xs text-danger break-all">
            Ошибка: {composeError}
          </div>
        )}

        {composeResult && (
          <Card>
            <CardContent className="p-5 space-y-3">
              <div className="flex items-start justify-between">
                <h3 className="text-sm font-semibold text-text-primary">Результат</h3>
                <Badge variant="success" dot>Готово</Badge>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="space-y-0.5">
                  <p className="text-xs text-text-tertiary">ID</p>
                  <p className="text-xs text-text-secondary font-mono">{composeResult.test_id}</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs text-text-tertiary">Пресет</p>
                  <p className="text-xs text-text-secondary">{composeResult.preset}</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs text-text-tertiary">Длительность</p>
                  <p className="text-xs text-text-secondary">{composeResult.compose_result.duration_sec.toFixed(1)}с</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs text-text-tertiary">Размер файла</p>
                  <p className="text-xs text-text-secondary">
                    {(composeResult.compose_result.file_size_bytes / 1024 / 1024).toFixed(2)} МБ
                  </p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs text-text-tertiary">Разрешение</p>
                  <p className="text-xs text-text-secondary">
                    {composeResult.compose_result.width}x{composeResult.compose_result.height}
                  </p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs text-text-tertiary">Сцен</p>
                  <p className="text-xs text-text-secondary">{composeResult.compose_result.scene_count}</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs text-text-tertiary">Время рендеринга</p>
                  <p className="text-xs text-text-secondary">{(composeResult.elapsed_ms / 1000).toFixed(1)}с</p>
                </div>
              </div>
              <div className="pt-2">
                <a
                  href={composeResult.output_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 px-4 py-2 text-xs font-medium text-white transition-colors"
                >
                  Скачать / Просмотреть видео
                </a>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Explanation */}
      <Card>
        <CardContent className="p-4">
          <p className="text-xs text-text-tertiary leading-relaxed">
            <strong className="text-text-secondary">Как это работает:</strong>{" "}
            Каждый сервис отправляет heartbeat в Redis каждые 15 секунд. Кнопка «Перезапустить»
            отправляет команду через Redis pub/sub — сервис выполняет graceful shutdown
            (завершает текущие задачи) и перезапускается процесс-менеджером (Docker / PM2).
            Если сервис запущен вручную без процесс-менеджера, он просто остановится.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

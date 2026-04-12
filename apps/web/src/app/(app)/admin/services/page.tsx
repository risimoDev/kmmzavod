"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Button, Badge, Card, CardContent } from "@/components/ui/primitives";
import { adminApi, type ServiceHealth, type DualApiCheck, type ProxyCheckResult } from "@/lib/admin-api";
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
  const [apiChecks, setApiChecks] = useState<DualApiCheck[]>([]);
  const [apiChecking, setApiChecking] = useState(false);
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);

  // Proxy check state
  const [proxyCheck, setProxyCheck] = useState<ProxyCheckResult | null>(null);
  const [proxyChecking, setProxyChecking] = useState(false);
  const [proxyCheckError, setProxyCheckError] = useState<string | null>(null);

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
      setProxyUrl(res.proxyUrl);
    } catch (e: any) {
      setApiChecks([{
        name: 'error',
        direct: { name: 'error', status: 'error', latencyMs: 0, error: e.message },
        proxy: null,
      }]);
      setProxyUrl(null);
    } finally {
      setApiChecking(false);
    }
  };

  const handleCheckProxy = async () => {
    if (proxyChecking) return;
    setProxyChecking(true);
    setProxyCheckError(null);
    try {
      const res = await adminApi.checkProxy();
      setProxyCheck(res);
    } catch (e: any) {
      setProxyCheckError(e.message);
    } finally {
      setProxyChecking(false);
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
            <p className="text-xs text-text-tertiary mt-0.5">
              Тест доступности внешних сервисов
              {proxyUrl && <span className="ml-1 text-brand-400">· прокси: {proxyUrl}</span>}
              {proxyUrl === null && apiChecks.length > 0 && <span className="ml-1 text-text-quaternary">· прокси не задан</span>}
            </p>
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
              const d = check.direct;
              const p = check.proxy;
              const directOk = d.status === "ok";
              const proxyOk = p?.status === "ok";

              return (
                <Card key={check.name} className={cn("transition-all", !directOk && "border-danger/30 bg-danger/5")}>
                  <CardContent className="p-5 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-text-primary">{meta.label}</h3>
                        <p className="text-xs text-text-tertiary mt-0.5">{meta.desc}</p>
                      </div>
                      <Badge variant={directOk ? "success" : "danger"} dot>
                        {directOk ? "OK" : "Ошибка"}
                      </Badge>
                    </div>

                    {/* Direct result */}
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-text-quaternary font-medium">Напрямую</p>
                      <div className="flex justify-between text-xs">
                        <span className="text-text-tertiary">Задержка</span>
                        <span className="text-text-secondary font-mono">{d.latencyMs}мс</span>
                      </div>
                      {d.info && (
                        <div className="flex justify-between text-xs">
                          <span className="text-text-tertiary">Инфо</span>
                          <span className="text-text-secondary">{d.info}</span>
                        </div>
                      )}
                      {d.error && (
                        <p className="text-xs text-danger/80 break-all">{d.error}</p>
                      )}
                    </div>

                    {/* Proxy result */}
                    {p && (
                      <div className="space-y-1.5 border-t border-border/50 pt-2">
                        <div className="flex items-center gap-1.5">
                          <p className="text-[10px] uppercase tracking-wider text-text-quaternary font-medium">Через прокси</p>
                          <Badge variant={proxyOk ? "success" : "danger"} className="text-[9px] px-1.5 py-0">
                            {proxyOk ? "OK" : "Ошибка"}
                          </Badge>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-text-tertiary">Задержка</span>
                          <span className="text-text-secondary font-mono">{p.latencyMs}мс</span>
                        </div>
                        {p.info && (
                          <div className="flex justify-between text-xs">
                            <span className="text-text-tertiary">Инфо</span>
                            <span className="text-text-secondary">{p.info}</span>
                          </div>
                        )}
                        {p.error && (
                          <p className="text-xs text-danger/80 break-all">{p.error}</p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
            {apiChecks.find(c => c.name === 'error') && (
              <div className="col-span-full rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
                Ошибка запроса: {apiChecks.find(c => c.name === 'error')?.direct.error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Proxy Check */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Проверка прокси</h2>
            <p className="text-xs text-text-tertiary mt-0.5">
              Тест связности прокси — сравнивает внешний IP с прямым запросом
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleCheckProxy} disabled={proxyChecking}>
            {proxyChecking ? "Проверка…" : "Проверить прокси"}
          </Button>
        </div>

        {proxyCheckError && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
            {proxyCheckError}
          </div>
        )}

        {proxyCheck && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Direct */}
            <Card className={cn(!proxyCheck.direct || proxyCheck.direct.status === 'error' ? "border-danger/30 bg-danger/5" : "")}>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">Прямое соединение</h3>
                    <p className="text-xs text-text-tertiary mt-0.5">Без прокси</p>
                  </div>
                  <Badge variant={proxyCheck.direct?.status === 'ok' ? "success" : "danger"} dot>
                    {proxyCheck.direct?.status === 'ok' ? "Доступен" : "Ошибка"}
                  </Badge>
                </div>
                {proxyCheck.direct && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-tertiary">Задержка</span>
                      <span className="text-text-secondary font-mono">{proxyCheck.direct.latencyMs}мс</span>
                    </div>
                    {proxyCheck.direct.ip && (
                      <div className="flex justify-between text-xs">
                        <span className="text-text-tertiary">Внешний IP</span>
                        <span className="text-text-secondary font-mono">{proxyCheck.direct.ip}</span>
                      </div>
                    )}
                    {proxyCheck.direct.error && (
                      <p className="text-xs text-danger/80 break-all">{proxyCheck.direct.error}</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Proxy */}
            <Card className={cn(
              !proxyCheck.configured ? "border-border/30 opacity-60" :
              proxyCheck.proxy?.status === 'error' ? "border-danger/30 bg-danger/5" : ""
            )}>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">Через прокси</h3>
                    <p className="text-xs text-text-tertiary mt-0.5 break-all">
                      {proxyCheck.proxyUrl ?? "не настроен"}
                    </p>
                  </div>
                  {!proxyCheck.configured ? (
                    <Badge variant="default">Не задан</Badge>
                  ) : (
                    <Badge variant={proxyCheck.proxy?.status === 'ok' ? "success" : "danger"} dot>
                      {proxyCheck.proxy?.status === 'ok' ? "Работает" : "Ошибка"}
                    </Badge>
                  )}
                </div>
                {proxyCheck.proxy && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-tertiary">Задержка</span>
                      <span className="text-text-secondary font-mono">{proxyCheck.proxy.latencyMs}мс</span>
                    </div>
                    {proxyCheck.proxy.ip && (
                      <div className="flex justify-between text-xs">
                        <span className="text-text-tertiary">Внешний IP (прокси)</span>
                        <span className={cn("font-mono text-xs", proxyCheck.proxy.ip !== proxyCheck.direct?.ip ? "text-brand-400" : "text-text-secondary")}>
                          {proxyCheck.proxy.ip}
                          {proxyCheck.proxy.ip !== proxyCheck.direct?.ip && " ✓ другой"}
                        </span>
                      </div>
                    )}
                    {proxyCheck.proxy.error && (
                      <p className="text-xs text-danger/80 break-all">{proxyCheck.proxy.error}</p>
                    )}
                  </div>
                )}
                {!proxyCheck.configured && (
                  <p className="text-xs text-text-quaternary">
                    Задайте AI_PROXY_URL в Настройках → Прокси
                  </p>
                )}
              </CardContent>
            </Card>
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

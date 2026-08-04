# device-agent

Мост между оркестратором kmmzavod (сервер) и Laixi Master (домашний ПК с
подключённой телефонной фермой). Запускается **на домашнем Windows-ПК**,
рядом с Laixi — не в docker-compose сервера. См. общую схему:
[docs/PHONE_FARM_INTEGRATION_PLAN.md](../../docs/PHONE_FARM_INTEGRATION_PLAN.md).

Слушает HTTP только на IP AmneziaWG-интерфейса (см.
[infra/amneziawg](../../infra/amneziawg)), внутрь дёргает локальный Laixi
WebSocket API (`ws://127.0.0.1:22221`).

## Запуск (на домашнем ПК, после установки AmneziaWG-клиента и коннекта)

```powershell
cd apps\device-agent
pnpm install
pnpm build

# .env рядом с dist/index.js (или переменные окружения Windows):
#   DEVICE_AGENT_HOST=10.13.13.2      # ваш IP на AmneziaWG-интерфейсе
#   DEVICE_AGENT_PORT=8300
#   LAIXI_WS_URL=ws://127.0.0.1:22221/
#   DEVICE_AGENT_SCRIPTS_DIR=C:\device-agent\scripts   # скопируйте сюда apps/device-agent/scripts
#   DEVICE_AGENT_DOWNLOAD_DIR=/sdcard/DCIM/kmmzavod

pnpm start
```

Держать процесс живым как Windows-службу — проще всего через
[NSSM](https://nssm.cc/) (`nssm install kmmzavod-device-agent`) или PM2
(`pm2 start dist/index.js --name device-agent`).

## Проверка

```powershell
curl http://10.13.13.2:8300/health
curl http://10.13.13.2:8300/devices   # список устройств из Laixi GetAllinfo
```

Если `/devices` падает — Laixi WS API либо не включён в вашей лицензии, либо
слушает не на 22221, либо Laixi Master не запущен. Смотрите логи процесса
(`laixi: send` / `laixi: raw response` в debug) чтобы увидеть точный формат
ответа Laixi и при необходимости поправить `src/laixi-client.ts`.

## Калибровка сценариев публикации

`scripts/*.template.js` — стартовые Autox.js-сценарии, требуют донастройки
под реальные экраны Instagram/TikTok на ваших телефонах. См.
`scripts/README.md`.

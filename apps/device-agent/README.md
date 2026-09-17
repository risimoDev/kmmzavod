# device-agent (Native ADB Phone Farm Bridge)

Мост между оркестратором kmmzavod (сервер AWS) и стойкой плат Android-телефонов (домашний ПК с подключёнными USB-платами).
Запускается **на домашнем Windows-ПК** и управляет платами **напрямую через официальный Google ADB** (`platform-tools`), **без платного софта (Laixi)**.

См. общую схему: [docs/PHONE_FARM_INTEGRATION_PLAN.md](../../docs/PHONE_FARM_INTEGRATION_PLAN.md).

Слушает HTTP только на защищённом IP AmneziaWG-туннеля (см. [infra/amneziawg](../../infra/amneziawg)), напрямую отправляет команды в `adb.exe`.

## Преимущества Native ADB перед Laixi:
- **100% бесплатно и Open-Source** (Apache 2.0).
- **Без ограничений на количество плат** (20, 50, 100+ плат).
- **Мгновенный захват экрана** (`exec-out screencap -p` в память за ~150мс без задержек).
- **USB-push видео** — видео передаются с ПК на плату по кабелю со скоростью USB, экономя мобильный трафик прокси.
- **Встроенная поддержка прогрева карточек Wildberries (WB)**.

---

## Быстрый запуск

Самый простой способ — запустить готовый скрипт:
```cmd
start-farm.bat
```
Скрипт автоматически найдёт `adb.exe` на вашем компьютере, запустит ADB-сервер и стартует `device-agent`.

### Ручной запуск:

```powershell
cd apps\device-agent
pnpm install
pnpm build

# Настройки .env (или переменные среды Windows):
#   DEVICE_AGENT_HOST=10.13.13.2      # IP домашнего ПК в AmneziaWG
#   DEVICE_AGENT_PORT=8300
#   ADB_PATH=adb                      # путь к adb.exe
#   DEVICE_AGENT_DOWNLOAD_DIR=/sdcard/DCIM/Camera

pnpm start
```

Для постоянного автозапуска в фоне используйте [NSSM](https://nssm.cc/) (`nssm install kmmzavod-device-agent`) или PM2 (`pm2 start dist/index.js --name device-agent`).

---

## Проверка работы

```powershell
# Проверка доступности агента
curl http://10.13.13.2:8300/health

# Список обнаруженных Android-плат
curl http://10.13.13.2:8300/devices

# Захват экрана конкретной платы
curl http://10.13.13.2:8300/devices/<DEVICE_ID>/screenshot

# Прогрев карточки товара Wildberries
curl -X POST http://10.13.13.2:8300/wb/warmup -H "Content-Type: application/json" -d "{\"deviceId\":\"<DEVICE_ID>\",\"sku\":\"1145510159\",\"dwellTimeSeconds\":45,\"swipePhotos\":true,\"readReviews\":true,\"addToFavorites\":true}"
```

---

## Функционал

1. **Публикация видео в соцсети (Instagram Reels / TikTok)**:
   - Быстрая передача файла через USB `adb push`.
   - Регистрация в MediaStore через broadcast `android.intent.action.MEDIA_SCANNER_SCAN_FILE`.
   - Запуск интента шеринга `android.intent.action.SEND`.
2. **Умный прогрев соцсетей (Smart View Warmup)**:
   - Проверка чистоты прокси (Anti-Leak test).
   - Человекоподобные свайпы и досмотры целевых аккаунтов.
3. **Прогрев карточек Wildberries (WB Warmup)**:
   - Deep-link переход в карточку товара `wildberries://card?nmId={sku}` в официальном приложении WB.
   - Имитация органического поведения покупателя: просмотр фотогалереи, чтение отзывов и характеристик, добавление в избранное, удержание времени в карточке для максимального поднятия в поиске WB.
4. **Авто-лечение и диагностика стойки (Auto-Heal)**:
   - Мониторинг температуры батарей/контроллеров стойки.
   - Снятие зависших ANR-окон и пробуждение экрана.

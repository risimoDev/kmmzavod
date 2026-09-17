# Автоматизация публикации и сценарии
 
В текущей версии `device-agent` управление выполняется **напрямую через ADB**:
- Видео передается по USB через `adb push` мгновенно без расхода мобильного интернета.
- Галерея обновляется через Android MediaScanner broadcast.
- Приложения Instagram, TikTok и Wildberries запускаются через прямые системные интенты (`android.intent.action.SEND`, deep-link `wildberries://card?nmId=...`).

Файлы `.template.js` сохранены как референсные шаблоны селекторов UI (если потребуется тонкая кликовая доводка через uiautomator или accessibility-сервис).

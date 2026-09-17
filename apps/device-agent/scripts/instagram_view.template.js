// Autox.js — автоматический органический просмотр и прогрев рилсов Instagram.
// Поддерживает человекоподобные паузы, рандомизацию удержания (watch time), двойной тап (Like) и скролл.
// Плейсхолдеры подставляются device-agent'ом:
// __TARGET_USERNAME__, __WATCH_DURATION_SEC__, __SCROLL_COUNT__, __LIKE_PROBABILITY__

"ui";
auto.waitFor();

var TARGET_USERNAME = "__TARGET_USERNAME__";
var BASE_WATCH_SEC = parseInt("__WATCH_DURATION_SEC__", 10) || 25;
var SCROLL_COUNT = parseInt("__SCROLL_COUNT__", 10) || 3;
var LIKE_PROB = parseFloat("__LIKE_PROBABILITY__") || 0.3;
var PKG = "com.instagram.android";

function log(msg) { console.log("[ig-view] " + msg); }

function wakeAndUnlock() {
    if (!device.isScreenOn()) {
        device.wakeUp();
        sleep(1000);
    }
}

function openTargetProfile() {
    log("Opening profile: " + TARGET_USERNAME);
    try {
        app.startActivity({
            action: "android.intent.action.VIEW",
            data: "instagram://user?username=" + TARGET_USERNAME,
            packageName: PKG
        });
    } catch (e) {
        log("Direct intent failed, launching app manually: " + e);
        app.launchApp("Instagram");
    }
    sleep(4000);

    if (currentPackage() !== PKG) {
        app.launchApp("Instagram");
        sleep(3000);
    }
}

function tapFirstReelOrPost() {
    log("Locating first video/reel in profile");
    // Ждём загрузку профиля
    sleep(2000);

    // Попытка перейти на вкладку Reels, если есть
    var reelsTab = descContains("Reels").findOne(3000)
        || descContains("РИЛС").findOne(1000)
        || textContains("Reels").findOne(1000);
    if (reelsTab) {
        log("Tapping Reels tab");
        reelsTab.click();
        sleep(2000);
    }

    // Кликаем по первой миниатюре в сетке
    // На экране сетки постов первая карточка обычно в верхней трети
    var gridItem = id("com.instagram.android:id/media_thumbnail_image").findOne(4000)
        || className("android.widget.ImageView").clickable(true).findOne(3000);

    if (gridItem) {
        log("Found grid thumbnail, clicking");
        gridItem.click();
    } else {
        log("Grid item not found by selector, clicking center of first row");
        click(device.width * 0.25, device.height * 0.45);
    }
    sleep(3000);
}

function naturalSwipeUp() {
    var startX = Math.round(device.width * 0.5 + (Math.random() * 60 - 30));
    var startY = Math.round(device.height * 0.76 + (Math.random() * 40 - 20));
    var endX = Math.round(startX + (Math.random() * 40 - 20));
    var endY = Math.round(device.height * 0.24 + (Math.random() * 40 - 20));
    var duration = Math.round(380 + Math.random() * 150);

    log("Swiping next video: (" + startX + "," + startY + ") -> (" + endX + "," + endY + ") in " + duration + "ms");
    swipe(startX, startY, endX, endY, duration);
}

function doubleTapLike() {
    var cx = Math.round(device.width * 0.5 + (Math.random() * 40 - 20));
    var cy = Math.round(device.height * 0.5 + (Math.random() * 40 - 20));
    log("Double-tapping center to like: (" + cx + "," + cy + ")");
    press(cx, cy, 60);
    sleep(130);
    press(cx, cy, 60);
}

try {
    log("Starting IG Smart View for @" + TARGET_USERNAME);
    wakeAndUnlock();
    openTargetProfile();
    tapFirstReelOrPost();

    var watched = 0;
    var likes = 0;

    for (var i = 0; i < SCROLL_COUNT; i++) {
        var watchTime = Math.max(8000, Math.round((BASE_WATCH_SEC * 1000) + (Math.random() * 8000 - 4000)));
        log("Watching video " + (i + 1) + "/" + SCROLL_COUNT + " for " + Math.round(watchTime / 1000) + "s");

        // Если видео длинное, смотрим частями с возможными микро-паузами
        var halfTime = Math.round(watchTime * 0.6);
        sleep(halfTime);

        if (Math.random() < LIKE_PROB) {
            doubleTapLike();
            likes++;
            sleep(1500);
        }

        sleep(watchTime - halfTime);
        watched++;

        if (i < SCROLL_COUNT - 1) {
            naturalSwipeUp();
            sleep(Math.round(1500 + Math.random() * 2000));
        }
    }

    log("Completed: watched=" + watched + ", likes=" + likes);
    sleep(2000);
    home();
} catch (e) {
    log("FAILED: " + e);
    home();
    exit();
}

// Autox.js — автоматический органический просмотр и прогрев видео TikTok.
// Поддерживает человекоподобные паузы, удержание (watch time), двойной тап (Like) и свайпы.
// Плейсхолдеры подставляются device-agent'ом:
// __TARGET_USERNAME__, __WATCH_DURATION_SEC__, __SCROLL_COUNT__, __LIKE_PROBABILITY__

"ui";
auto.waitFor();

var TARGET_USERNAME = "__TARGET_USERNAME__";
var BASE_WATCH_SEC = parseInt("__WATCH_DURATION_SEC__", 10) || 25;
var SCROLL_COUNT = parseInt("__SCROLL_COUNT__", 10) || 3;
var LIKE_PROB = parseFloat("__LIKE_PROBABILITY__") || 0.3;
var PKG_TIKTOK = "com.zhiliaoapp.musically";
var PKG_TIKTOK_TR = "com.ss.android.ugc.trill";

function log(msg) { console.log("[tt-view] " + msg); }

function wakeAndUnlock() {
    if (!device.isScreenOn()) {
        device.wakeUp();
        sleep(1000);
    }
}

function openTargetProfile() {
    log("Opening TikTok profile: " + TARGET_USERNAME);
    // Ссылка на профиль открывается TikTok'ом через deep link или web intent
    try {
        app.startActivity({
            action: "android.intent.action.VIEW",
            data: "https://www.tiktok.com/@" + TARGET_USERNAME
        });
    } catch (e) {
        log("Browser intent failed, trying snssdk: " + e);
        try {
            app.startActivity({
                action: "android.intent.action.VIEW",
                data: "snssdk1233://user/profile/" + TARGET_USERNAME
            });
        } catch (e2) {
            log("Deep link failed, launching TikTok app: " + e2);
            app.launchApp("TikTok");
        }
    }
    sleep(4500);
}

function tapFirstVideoInProfile() {
    log("Finding first video in TikTok profile");
    sleep(2000);

    // В TikTok первой карточкой обычно является первое видео в сетке
    var videoItem = idContains("cover").findOne(3000)
        || className("android.widget.ImageView").clickable(true).findOne(3000);

    if (videoItem) {
        log("Tapping video cover");
        videoItem.click();
    } else {
        log("Clicking default first video coordinate");
        click(device.width * 0.2, device.height * 0.48);
    }
    sleep(3000);
}

function naturalSwipeUp() {
    var startX = Math.round(device.width * 0.5 + (Math.random() * 50 - 25));
    var startY = Math.round(device.height * 0.78 + (Math.random() * 30 - 15));
    var endX = Math.round(startX + (Math.random() * 30 - 15));
    var endY = Math.round(device.height * 0.22 + (Math.random() * 30 - 15));
    var duration = Math.round(360 + Math.random() * 140);

    log("Swiping next video: (" + startX + "," + startY + ") -> (" + endX + "," + endY + ") in " + duration + "ms");
    swipe(startX, startY, endX, endY, duration);
}

function doubleTapLike() {
    var cx = Math.round(device.width * 0.5 + (Math.random() * 40 - 20));
    var cy = Math.round(device.height * 0.5 + (Math.random() * 40 - 20));
    log("Double-tapping video center to like: (" + cx + "," + cy + ")");
    press(cx, cy, 60);
    sleep(120);
    press(cx, cy, 60);
}

try {
    log("Starting TikTok Smart View for @" + TARGET_USERNAME);
    wakeAndUnlock();
    openTargetProfile();
    tapFirstVideoInProfile();

    var watched = 0;
    var likes = 0;

    for (var i = 0; i < SCROLL_COUNT; i++) {
        var watchTime = Math.max(8000, Math.round((BASE_WATCH_SEC * 1000) + (Math.random() * 7000 - 3500)));
        log("Watching TikTok video " + (i + 1) + "/" + SCROLL_COUNT + " for " + Math.round(watchTime / 1000) + "s");

        var halfTime = Math.round(watchTime * 0.55);
        sleep(halfTime);

        if (Math.random() < LIKE_PROB) {
            doubleTapLike();
            likes++;
            sleep(1200);
        }

        sleep(watchTime - halfTime);
        watched++;

        if (i < SCROLL_COUNT - 1) {
            naturalSwipeUp();
            sleep(Math.round(1500 + Math.random() * 2000));
        }
    }

    log("Completed TikTok Smart View: watched=" + watched + ", likes=" + likes);
    sleep(2000);
    home();
} catch (e) {
    log("FAILED: " + e);
    home();
    exit();
}

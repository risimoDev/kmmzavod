// Autox.js — публикация Reels в Instagram через реальное приложение.
// СТАБ — калибровать на реальном устройстве, см. scripts/README.md.
// Плейсхолдеры __VIDEO_PATH__ / __CAPTION__ подставляются device-agent'ом.

"ui";
auto.waitFor();

var VIDEO_PATH = "__VIDEO_PATH__";
var CAPTION = "__CAPTION__";
var PKG = "com.instagram.android";

function log(msg) { console.log("[ig-post] " + msg); }

function openApp() {
    app.launchApp("Instagram");
    sleep(3000);
    if (!currentPackage() || currentPackage() !== PKG) {
        throw new Error("instagram did not come to foreground");
    }
}

function tapNewPost() {
    // Нижняя панель "+" — id меняется между версиями, ПРОВЕРИТЬ на устройстве.
    var plus = id("com.instagram.android:id/creation_tab").findOne(8000)
        || desc("Create").findOne(3000)
        || text("Create").findOne(3000);
    if (!plus) throw new Error("create-post button not found — recalibrate selector");
    plus.click();
    sleep(1500);
}

function selectVideoFromGallery() {
    // Ожидается, что VIDEO_PATH уже лежит в галерее (после httpdown/MediaScanner).
    // Обычно самый свежий элемент в гриде — первый.
    var firstItem = className("android.widget.ImageView")
        .filter(function (v) { return v.desc() != null; })[0];
    if (!firstItem) throw new Error("gallery grid item not found");
    firstItem.click();
    sleep(1000);

    var next1 = text("Next").findOne(5000) || desc("Next").findOne(5000);
    if (!next1) throw new Error("first Next not found");
    next1.click();
    sleep(1500);

    var next2 = text("Next").findOne(5000) || desc("Next").findOne(5000);
    if (next2) { next2.click(); sleep(1500); }
}

function enterCaptionAndShare() {
    var captionField = className("android.widget.EditText").findOne(5000);
    if (!captionField) throw new Error("caption field not found");
    captionField.setText(CAPTION);
    sleep(500);

    var share = text("Share").findOne(5000) || desc("Share").findOne(5000);
    if (!share) throw new Error("share button not found");
    share.click();
    sleep(4000);
}

try {
    log("start");
    openApp();
    tapNewPost();
    selectVideoFromGallery();
    enterCaptionAndShare();
    log("done");
} catch (e) {
    log("FAILED: " + e);
    exit();
}

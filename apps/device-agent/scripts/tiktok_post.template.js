// Autox.js — публикация в TikTok через реальное приложение.
// СТАБ — калибровать на реальном устройстве, см. scripts/README.md.
// Плейсхолдеры __VIDEO_PATH__ / __CAPTION__ подставляются device-agent'ом.

"ui";
auto.waitFor();

var VIDEO_PATH = "__VIDEO_PATH__";
var CAPTION = "__CAPTION__";
var PKG = "com.zhiliaoapp.musically"; // международный TikTok; com.ss.android.ugc.trill в некоторых сборках

function log(msg) { console.log("[tt-post] " + msg); }

function openApp() {
    launchApp(PKG);
    sleep(3000);
    if (currentPackage() !== PKG) {
        throw new Error("tiktok did not come to foreground — check package name for your build");
    }
}

function tapPlusThenUpload() {
    var plus = desc("Create").findOne(8000) || text("+").findOne(3000);
    if (!plus) throw new Error("create button not found — recalibrate selector");
    plus.click();
    sleep(2000);

    var upload = text("Upload").findOne(5000) || desc("Upload").findOne(5000);
    if (upload) { upload.click(); sleep(1500); }
}

function selectVideoFromGallery() {
    var firstItem = className("android.widget.ImageView")
        .filter(function (v) { return v.desc() != null; })[0];
    if (!firstItem) throw new Error("gallery grid item not found");
    firstItem.click();
    sleep(1000);

    var next = text("Next").findOne(5000) || desc("Next").findOne(5000);
    if (!next) throw new Error("Next not found");
    next.click();
    sleep(2000);
}

function enterCaptionAndPost() {
    var captionField = className("android.widget.EditText").findOne(5000);
    if (!captionField) throw new Error("caption field not found");
    captionField.setText(CAPTION);
    sleep(500);

    var post = text("Post").findOne(5000) || desc("Post").findOne(5000);
    if (!post) throw new Error("post button not found");
    post.click();
    sleep(5000);
}

try {
    log("start");
    openApp();
    tapPlusThenUpload();
    selectVideoFromGallery();
    enterCaptionAndPost();
    log("done");
} catch (e) {
    log("FAILED: " + e);
    exit();
}

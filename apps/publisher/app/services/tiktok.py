"""
TikTok publishing via tiktok-uploader (Selenium + headless Chromium).

TikTok has no stable public upload API for arbitrary accounts, so this drives a
headless browser authenticated by the account's `sessionid` cookie. This path is
inherently more fragile than the Instagram one and is sensitive to the installed
tiktok-uploader version — keep the dependency pinned.

session_data: { "sessionid"?, "cookies"? }   (at least one required)
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlparse

from app.config import settings

logger = logging.getLogger(__name__)


def _parse_proxy(proxy_url: str | None) -> dict[str, str] | None:
    if not proxy_url:
        return None
    u = urlparse(proxy_url)
    if not u.hostname:
        return None
    proxy: dict[str, str] = {"host": u.hostname, "port": str(u.port or "")}
    if u.username:
        proxy["user"] = u.username
    if u.password:
        proxy["pass"] = u.password
    return proxy


def _chrome_options():
    """Headless Chromium options pointing at the container's browser binary."""
    try:
        from selenium.webdriver.chrome.options import Options
        opts = Options()
        if settings.chrome_binary:
            opts.binary_location = settings.chrome_binary
        opts.add_argument("--headless=new")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        opts.add_argument("--disable-gpu")
        return opts
    except Exception:
        return None


def publish(
    session_data: dict[str, Any],
    video_path: str,
    caption: str,
    proxy_url: str | None = None,
) -> bool:
    """Upload a video to TikTok. Returns True on success, raises on failure."""
    sessionid = session_data.get("sessionid")
    cookies_list = session_data.get("cookies")
    if not sessionid and not cookies_list:
        raise ValueError("tiktok session_data needs sessionid or cookies")

    from tiktok_uploader.upload import upload_video

    kwargs: dict[str, Any] = {
        "filename": video_path,
        "description": caption or "",
        "headless": True,
    }
    if sessionid:
        kwargs["sessionid"] = sessionid
    if cookies_list:
        kwargs["cookies_list"] = cookies_list
    proxy = _parse_proxy(proxy_url)
    if proxy:
        kwargs["proxy"] = proxy
    opts = _chrome_options()
    if opts is not None:
        kwargs["options"] = opts

    # tiktok-uploader's signature varies across versions — drop unsupported kwargs.
    for drop in (None, "options", "proxy"):
        try:
            if drop:
                kwargs.pop(drop, None)
            failed = upload_video(**kwargs)
            break
        except TypeError as e:
            logger.warning("tiktok upload_video kwarg unsupported (%s), retrying simpler: %s", drop, e)
            continue
    else:
        raise RuntimeError("tiktok-uploader upload_video signature incompatible")

    if failed:  # non-empty list = some uploads failed
        raise RuntimeError("tiktok upload reported failure")
    return True

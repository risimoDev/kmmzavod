"""
TikTok publishing via tiktok-uploader (Selenium + headless Chromium).

TikTok has no stable public upload API for arbitrary accounts, so this drives a
headless browser authenticated by the account's `sessionid` cookie. This path is
inherently more fragile than the Instagram one and is sensitive to the installed
tiktok-uploader version — keep the dependency pinned.

session_data: { "sessionid"?, "cookies"? }   (at least one required)
"""

from __future__ import annotations

import inspect
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
    if proxy_url and not proxy:
        # Never fall back to the server's own IP: that links every account to it.
        raise ValueError("tiktok: proxy_url is set but could not be parsed — refusing to upload without proxy")
    if proxy:
        kwargs["proxy"] = proxy
    opts = _chrome_options()
    if opts is not None:
        kwargs["options"] = opts

    # tiktok-uploader's signature varies across versions. Decide up front which kwargs
    # it accepts instead of retrying on TypeError: a TypeError raised *inside* the
    # upload would otherwise trigger a second upload, possibly without the proxy.
    params = inspect.signature(upload_video).parameters
    accepts_any = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())
    if not accepts_any:
        if "proxy" in kwargs and "proxy" not in params:
            raise RuntimeError(
                "installed tiktok-uploader does not support `proxy` — refusing to upload from the server IP"
            )
        unsupported = [k for k in kwargs if k not in params]
        for k in unsupported:
            logger.warning("tiktok upload_video: dropping unsupported kwarg %s", k)
            kwargs.pop(k)

    failed = upload_video(**kwargs)

    if failed:  # non-empty list = some uploads failed
        raise RuntimeError("tiktok upload reported failure")
    return True

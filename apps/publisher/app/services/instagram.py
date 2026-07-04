"""
Instagram publishing via instagrapi (private API, pure HTTP — no browser).

Session strategy: the orchestrator stores an opaque `session_data` blob per account:
  { "username", "password", "settings"? , "sessionid"? }
On first publish we log in with username/password (or sessionid), then return the
instagrapi `settings` (device + session) so the orchestrator can persist them. On
later publishes we load those settings → instagrapi reuses the session and avoids a
fresh login challenge. The account proxy + device must be applied BEFORE login.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from instagrapi import Client

logger = logging.getLogger(__name__)


def _sessionid_from_cookie(cookie: str | None) -> str | None:
    """Extract the sessionid value from a raw Cookie header string."""
    if not cookie:
        return None
    m = re.search(r"sessionid=([^;|\s]+)", cookie, re.IGNORECASE)
    return m.group(1) if m else None


def _make_client(
    session_data: dict[str, Any],
    proxy_url: str | None,
    fingerprint: dict[str, Any] | None,
) -> Client:
    cl = Client()
    cl.delay_range = [1, 3]  # human-like jitter between requests
    if proxy_url:
        cl.set_proxy(proxy_url)

    settings_blob = session_data.get("settings")
    if settings_blob:
        try:
            cl.set_settings(settings_blob)
        except Exception as e:
            logger.warning("instagram: failed to load saved settings, will re-login: %s", e)

    # On the very first login, align the user agent with the farm fingerprint so the
    # device looks consistent. Afterwards the persisted settings own the device.
    if fingerprint and not settings_blob:
        ua = fingerprint.get("userAgent")
        if ua:
            try:
                cl.set_user_agent(ua)
            except Exception:
                pass
    return cl


def _login(
    session_data: dict[str, Any],
    proxy_url: str | None = None,
    fingerprint: dict[str, Any] | None = None,
) -> Client:
    username = session_data.get("username")
    password = session_data.get("password")
    # sessionid may be explicit or embedded in a raw cookie string from import.
    sessionid = session_data.get("sessionid") or _sessionid_from_cookie(session_data.get("cookie"))
    cl = _make_client(session_data, proxy_url, fingerprint)

    try:
        if session_data.get("settings") and username and password:
            cl.login(username, password)        # reuses loaded session
        elif sessionid:
            cl.login_by_sessionid(sessionid)
        elif username and password:
            cl.login(username, password)        # fresh login
        else:
            raise ValueError("instagram session_data needs username+password or sessionid")
    except Exception as e:
        # Surface an actionable message (challenge / bad password / checkpoint).
        raise RuntimeError(f"instagram login failed: {type(e).__name__}: {e}") from e
    return cl


def _dump_session(cl: Client, session_data: dict[str, Any]) -> dict[str, Any]:
    out = dict(session_data)
    try:
        out["settings"] = cl.get_settings()
    except Exception:
        pass
    return out


def publish_reel(
    session_data: dict[str, Any],
    video_path: str,
    caption: str,
    proxy_url: str | None = None,
    fingerprint: dict[str, Any] | None = None,
) -> tuple[str | None, dict[str, Any]]:
    """Upload a Reel. Returns (external_id, refreshed_session_data)."""
    cl = _login(session_data, proxy_url, fingerprint)
    media = cl.clip_upload(video_path, caption or "")
    external_id = getattr(media, "code", None) or (str(getattr(media, "pk", "")) or None)
    return external_id, _dump_session(cl, session_data)


def warmup(
    session_data: dict[str, Any],
    proxy_url: str | None = None,
    like_count: int = 3,
    fingerprint: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    """Light warmup: open the timeline and like a few posts. Returns (actions, session)."""
    cl = _login(session_data, proxy_url, fingerprint)
    actions = 0
    try:
        feed = cl.get_timeline_feed()
        items = feed.get("feed_items", []) if isinstance(feed, dict) else []
        for item in items:
            if actions >= max(0, like_count):
                break
            media = item.get("media_or_ad") if isinstance(item, dict) else None
            if not isinstance(media, dict):
                continue
            media_id = media.get("id") or media.get("pk")
            if not media_id:
                continue
            try:
                cl.media_like(str(media_id))
                actions += 1
            except Exception as e:
                logger.warning("warmup like failed: %s", e)
    except Exception as e:
        logger.warning("warmup feed fetch failed: %s", e)
    return actions, _dump_session(cl, session_data)

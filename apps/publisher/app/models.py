"""Request/response models for the publisher service.

`session_data` is an opaque, per-account JSON blob owned by the orchestrator
(stored encrypted in the DB). The publisher reads credentials/session from it and
returns the (possibly refreshed) blob so the orchestrator can persist it again.

  Instagram session_data: { "username", "password", "settings"? }
  TikTok    session_data: { "sessionid"?, "cookies"? }
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class InstagramPublishRequest(BaseModel):
    video_url: str
    caption: str = ""
    proxy_url: str | None = None
    device_fingerprint: dict[str, Any] | None = None
    session_data: dict[str, Any] = Field(default_factory=dict)


class TiktokPublishRequest(BaseModel):
    video_url: str
    caption: str = ""
    proxy_url: str | None = None
    session_data: dict[str, Any] = Field(default_factory=dict)


class PublishResponse(BaseModel):
    ok: bool = True
    external_id: str | None = None
    # Refreshed session blob to persist (orchestrator re-encrypts it).
    session_data: dict[str, Any] = Field(default_factory=dict)


class WarmupRequest(BaseModel):
    proxy_url: str | None = None
    device_fingerprint: dict[str, Any] | None = None
    session_data: dict[str, Any] = Field(default_factory=dict)
    like_count: int = 3


class WarmupResponse(BaseModel):
    ok: bool = True
    actions: int = 0
    session_data: dict[str, Any] = Field(default_factory=dict)

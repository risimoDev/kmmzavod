"""MinIO/S3 storage client wrapper for video-processor."""

import os

import aioboto3
from botocore.config import Config

from app.config import settings


class StorageClient:
    def __init__(self):
        raw_ep = settings.minio_endpoint.strip()
        if raw_ep.startswith("https://"):
            scheme = "https"
            clean_ep = raw_ep[8:].rstrip("/")
        elif raw_ep.startswith("http://"):
            scheme = "http"
            clean_ep = raw_ep[7:].rstrip("/")
        else:
            scheme = "https" if settings.minio_secure else "http"
            clean_ep = raw_ep.rstrip("/")

        if ":" not in clean_ep:
            if scheme == "http" and settings.minio_port and settings.minio_port != 80:
                clean_ep = f"{clean_ep}:{settings.minio_port}"
            elif scheme == "https" and settings.minio_port and settings.minio_port != 443:
                clean_ep = f"{clean_ep}:{settings.minio_port}"

        self._endpoint_url = f"{scheme}://{clean_ep}"
        self._access_key = settings.minio_access_key
        self._secret_key = settings.minio_secret_key
        self._bucket = settings.minio_bucket
        self._region = getattr(settings, "minio_region", "us-east-1")

    def _session(self):
        return aioboto3.Session().client(
            "s3",
            endpoint_url=self._endpoint_url,
            aws_access_key_id=self._access_key,
            aws_secret_access_key=self._secret_key,
            region_name=self._region,
            config=Config(
                signature_version="s3v4",
                proxies={},
            ),
        )

    async def download(self, key: str, local_path: str) -> None:
        parent = os.path.dirname(local_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        async with self._session() as s3:
            await s3.download_file(self._bucket, key, local_path)

    async def upload(self, key: str, local_path: str, content_type: str = "application/octet-stream") -> None:
        async with self._session() as s3:
            await s3.upload_file(
                local_path,
                self._bucket,
                key,
                ExtraArgs={"ContentType": content_type},
            )

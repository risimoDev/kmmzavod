"""MinIO/S3 storage client wrapper for video-processor."""

import os

import aioboto3
from botocore.config import Config

from app.config import settings


class StorageClient:
    def __init__(self):
        scheme = "https" if settings.minio_secure else "http"
        self._endpoint_url = f"{scheme}://{settings.minio_endpoint}"
        self._access_key = settings.minio_access_key
        self._secret_key = settings.minio_secret_key
        self._bucket = settings.minio_bucket

    def _session(self):
        return aioboto3.Session().client(
            "s3",
            endpoint_url=self._endpoint_url,
            aws_access_key_id=self._access_key,
            aws_secret_access_key=self._secret_key,
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

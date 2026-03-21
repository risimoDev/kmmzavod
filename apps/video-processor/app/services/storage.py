"""MinIO/S3 storage client wrapper for video-processor."""

import aioboto3
import os


class StorageClient:
    def __init__(self):
        endpoint = os.environ["MINIO_ENDPOINT"]
        secure = os.environ.get("MINIO_SECURE", "false").lower() == "true"
        scheme = "https" if secure else "http"
        self._endpoint_url = f"{scheme}://{endpoint}"
        self._access_key = os.environ["MINIO_ACCESS_KEY"]
        self._secret_key = os.environ["MINIO_SECRET_KEY"]
        self._bucket = os.environ.get("MINIO_BUCKET", "kmmzavod")

    def _session(self):
        return aioboto3.Session().client(
            "s3",
            endpoint_url=self._endpoint_url,
            aws_access_key_id=self._access_key,
            aws_secret_access_key=self._secret_key,
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

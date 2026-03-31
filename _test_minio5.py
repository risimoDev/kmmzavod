"""Test aioboto3 with proxy bypass."""
import asyncio, sys
sys.path.insert(0, 'e:\\kmmzavod\\apps\\video-processor')

import aioboto3
from botocore.config import Config

async def main():
    session = aioboto3.Session()
    async with session.client(
        "s3",
        endpoint_url="http://localhost:9000",
        aws_access_key_id="kmmzavod",
        aws_secret_access_key="kmmzavod_minio_dev_123",
        config=Config(signature_version='s3v4', proxies={}),
    ) as s3:
        resp = await s3.list_buckets()
        print(f"Buckets: {[b['Name'] for b in resp['Buckets']]}")
        resp2 = await s3.list_objects_v2(Bucket='kmmzavod', MaxKeys=5)
        for obj in resp2.get("Contents", []):
            print(f"  - {obj['Key']} ({obj['Size']} bytes)")

asyncio.run(main())

"""Quick test of aioboto3 connection to MinIO."""
import asyncio, sys
sys.path.insert(0, 'e:\\kmmzavod\\apps\\video-processor')

import aioboto3

async def main():
    session = aioboto3.Session()
    async with session.client(
        "s3",
        endpoint_url="http://localhost:9000",
        aws_access_key_id="kmmzavod",
        aws_secret_access_key="kmmzavod_minio_dev_123",
    ) as s3:
        print("Listing buckets...")
        resp = await s3.list_buckets()
        for b in resp.get("Buckets", []):
            print(f"  - {b['Name']}")

        print("\nListing objects in kmmzavod (max 5)...")
        resp = await s3.list_objects_v2(Bucket="kmmzavod", MaxKeys=5)
        for obj in resp.get("Contents", []):
            print(f"  - {obj['Key']} ({obj['Size']} bytes)")

asyncio.run(main())

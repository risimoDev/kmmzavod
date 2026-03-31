"""Test MinIO with proxy bypass."""
import sys
sys.path.insert(0, 'e:\\kmmzavod\\apps\\video-processor')

import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="http://localhost:9000",
    aws_access_key_id="kmmzavod",
    aws_secret_access_key="kmmzavod_minio_dev_123",
    config=Config(
        signature_version='s3v4',
        proxies={},
    ),
)
try:
    resp = s3.list_buckets()
    print(f"Buckets: {[b['Name'] for b in resp['Buckets']]}")
    resp2 = s3.list_objects_v2(Bucket='kmmzavod', MaxKeys=5)
    for obj in resp2.get("Contents", []):
        print(f"  - {obj['Key']} ({obj['Size']} bytes)")
except Exception as e:
    print(f"Error: {type(e).__name__}: {e}")

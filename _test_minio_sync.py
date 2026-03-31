"""Test sync boto3 connection to MinIO."""
import sys
sys.path.insert(0, 'e:\\kmmzavod\\apps\\video-processor')
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="http://localhost:9000",
    aws_access_key_id="kmmzavod",
    aws_secret_access_key="kmmzavod_minio_dev_123",
    config=Config(signature_version='s3v4'),
)
print("Listing buckets...")
resp = s3.list_buckets()
for b in resp.get("Buckets", []):
    print(f"  - {b['Name']}")

print("\nListing objects (max 5)...")
resp = s3.list_objects_v2(Bucket="kmmzavod", MaxKeys=5)
for obj in resp.get("Contents", []):
    print(f"  - {obj['Key']} ({obj['Size']} bytes)")

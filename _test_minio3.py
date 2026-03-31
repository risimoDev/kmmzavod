"""Test MinIO with different approaches."""
import sys, json
sys.path.insert(0, 'e:\\kmmzavod\\apps\\video-processor')

import urllib.request

# Simple anonymous health check
try:
    r = urllib.request.urlopen("http://localhost:9000/minio/health/live", timeout=5)
    print(f"Health check: {r.status}")
except Exception as e:
    print(f"Health check failed: {e}")

# Now try boto3 with explicit config
import boto3
from botocore.config import Config

print("\n--- Attempt 1: signature_version=s3v4, no retries ---")
s3 = boto3.client(
    "s3",
    endpoint_url="http://localhost:9000",
    aws_access_key_id="kmmzavod",
    aws_secret_access_key="kmmzavod_minio_dev_123",
    config=Config(
        signature_version='s3v4',
        retries={'max_attempts': 0},
    ),
)
try:
    resp = s3.list_buckets()
    print(f"Buckets: {[b['Name'] for b in resp['Buckets']]}")
except Exception as e:
    print(f"boto3 error: {type(e).__name__}: {e}")

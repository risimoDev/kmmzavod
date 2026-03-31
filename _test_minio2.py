"""Test MinIO with python requests + boto3 signing."""
import sys
sys.path.insert(0, 'e:\\kmmzavod\\apps\\video-processor')

import requests

# Simple anonymous health check
r = requests.get("http://localhost:9000/minio/health/live", timeout=5)
print(f"Health check: {r.status_code} {r.text[:100]}")

# Try listing buckets with a signed request
import datetime, hashlib, hmac

# Actually, let's just try with urllib3 directly 
import urllib3
http = urllib3.PoolManager()
r2 = http.request('GET', 'http://localhost:9000/minio/health/live')
print(f"urllib3 health: {r2.status} {r2.data[:100]}")

# Now try boto3 with explicit config
import boto3
from botocore.config import Config

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
    print(f"boto3 error: {e}")

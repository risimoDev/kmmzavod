"""Quick debug script to check video-processor config."""
import sys
sys.path.insert(0, 'e:\\kmmzavod\\apps\\video-processor')

from app.config import settings

print(f"minio_endpoint: {settings.minio_endpoint}")
print(f"minio_port: {settings.minio_port}")
print(f"minio_access_key: {settings.minio_access_key}")
print(f"minio_secret_key: {settings.minio_secret_key}")
print(f"minio_bucket: {settings.minio_bucket}")
print(f"minio_secure: {settings.minio_secure}")

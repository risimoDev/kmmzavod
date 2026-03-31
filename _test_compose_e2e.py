"""Direct test of video-processor /compose endpoint using existing MinIO images."""
import json
import urllib.request

# Images we know exist in MinIO from the previous admin test
test_id = "11f37d61"
keys = [
    f"test/compose/{test_id}/scene_0_red.png",
    f"test/compose/{test_id}/scene_1_green.png",
    f"test/compose/{test_id}/scene_2_blue.png",
    f"test/compose/{test_id}/scene_3_yellow.png",
]

compose_request = {
    "job_id": f"pytest_{test_id}",
    "tenant_id": "test",
    "output_key": f"test/compose/{test_id}/output_e2e.mp4",
    "scenes": [
        {
            "scene_id": f"scene_{i}",
            "type": "image",
            "storage_key": key,
            "duration_sec": 3.0,
            "transition": "fade",
            "transition_duration": 0.3,
            "ken_burns": "auto",
        }
        for i, key in enumerate(keys)
    ],
    "subtitles": [
        {
            "start_sec": i * 3.0,
            "end_sec": (i + 1) * 3.0,
            "text": f"Test scene {i + 1}",
        }
        for i in range(len(keys))
    ],
    "settings": {"subtitle_style": "tiktok"},
}

data = json.dumps(compose_request).encode()
req = urllib.request.Request(
    "http://localhost:8000/compose",
    data=data,
    headers={"Content-Type": "application/json"},
)
try:
    resp = urllib.request.urlopen(req, timeout=300)
    body = resp.read().decode()
    print(f"HTTP {resp.status}")
    print(json.dumps(json.loads(body), indent=2))
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"HTTP {e.code}")
    print(body)
except Exception as e:
    print(f"Error: {type(e).__name__}: {e}")

FROM python:3.12-slim

# FFmpeg + libass (subtitle burn at render phase) + fonts.
# libgl1/libglib2.0-0 are required by opencv-python-headless.
# libsndfile1 is required by soundfile (librosa beat detection).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libass9 \
    fontconfig \
    fonts-liberation \
    libgl1 \
    libglib2.0-0 \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (better layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the Whisper model into the image at BUILD time. Without this the model
# is downloaded on the first transcription — if the host has no/flaky access to
# HuggingFace (типично для RU-сетей), transcription silently fails and videos
# come out without subtitles. download_model.py fetches via plain HTTPS with a
# mirror fallback (huggingface.co → hf-mirror.com), so the build works even
# where huggingface_hub does not. Set WHISPER_PRELOAD=none to skip.
ENV HF_HOME=/app/.hf
ARG WHISPER_PRELOAD=small
ARG HF_ENDPOINT=""
COPY download_model.py .
RUN HF_ENDPOINT="$HF_ENDPOINT" python download_model.py "$WHISPER_PRELOAD"

COPY . .

# Non-root user for security
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser \
    && mkdir -p /app/.hf && chown -R appuser:appgroup /app/.hf
USER appuser

EXPOSE 8300

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8300/health')"

# 1 worker per container; run multiple containers for scale.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8300", "--workers", "1", "--no-access-log"]

// Cross-platform dev script — spawns uvicorn from the local .venv
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { platform } from 'node:os';
import { existsSync } from 'node:fs';

const root = import.meta.dirname;
const py = join(root, '.venv', platform() === 'win32' ? 'Scripts' : 'bin', 'python');

// Build augmented environment: add FFmpeg to PATH (if found) and bypass proxy for localhost
const env = { ...process.env };

// FFmpeg: check common Windows locations
if (platform() === 'win32') {
  const ffmpegCandidates = [
    'C:\\OSPanel\\addons\\FFMpeg\\bin',
    'C:\\ffmpeg\\bin',
    'C:\\Program Files\\ffmpeg\\bin',
  ];
  for (const dir of ffmpegCandidates) {
    if (existsSync(join(dir, 'ffmpeg.exe'))) {
      env.PATH = `${dir};${env.PATH}`;
      break;
    }
  }
}

// Bypass proxy for local services (MinIO, etc.)
env.NO_PROXY = [env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',');

const proc = spawn(py, [
  '-m', 'uvicorn', 'app.main:app',
  '--host', '0.0.0.0',
  '--port', '8000',
  '--reload',
], { stdio: 'inherit', cwd: root, env });

proc.on('exit', (code) => process.exit(code ?? 1));

/**
 * Worker thread: RGBA framebuffer → 2x downsample → JPEG.
 * Runs the pure-TS encoder off the main event loop (it costs ~40-50 ms per
 * 1080x2400 frame, which would otherwise stall every HTTP request and ADB callback).
 */
import { parentPort } from 'node:worker_threads';
import { downsample2x, encodeJpeg } from './jpeg-encoder';

export interface JpegTask {
  id: number;
  pixels: Uint8Array; // RGBA, width * height * 4
  width: number;
  height: number;
  quality: number;
}

export interface JpegResult {
  id: number;
  jpeg?: Uint8Array;
  error?: string;
}

parentPort?.on('message', (task: JpegTask) => {
  try {
    const rgba = Buffer.from(task.pixels.buffer, task.pixels.byteOffset, task.pixels.byteLength);
    const down = downsample2x(rgba, task.width, task.height);
    const jpeg = encodeJpeg(down.data, down.width, down.height, task.quality);
    const out = new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
    const transferable = jpeg.byteOffset === 0 && jpeg.buffer.byteLength === jpeg.byteLength;
    parentPort!.postMessage({ id: task.id, jpeg: out } satisfies JpegResult, transferable ? [jpeg.buffer as ArrayBuffer] : []);
  } catch (err) {
    parentPort!.postMessage({ id: task.id, error: err instanceof Error ? err.message : String(err) } satisfies JpegResult);
  }
});

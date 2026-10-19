/**
 * Small worker_threads pool for frame encoding (see jpeg-worker.ts).
 *
 * Works both under `tsx` (workers inherit its loader, so the .ts file loads) and from
 * the compiled dist (.js). If a worker cannot be started at all, frames are encoded
 * inline on the main thread, which is exactly the old behaviour.
 */
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { downsample2x, encodeJpeg } from './jpeg-encoder';
import type { JpegResult, JpegTask } from './jpeg-worker';

const WORKER_FILE = path.join(__dirname, `jpeg-worker${path.extname(__filename) || '.js'}`);
const POOL_SIZE = Math.max(1, Math.min(4, os.cpus().length - 1));

interface Pending {
  resolve: (jpeg: Buffer) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  busy: Map<number, Pending>;
  replied: boolean;
}

/** Workers that die before ever answering → assume they cannot run here at all. */
const MAX_STARTUP_FAILURES = 3;

class JpegPool {
  private slots: Slot[] = [];
  private nextId = 1;
  private next = 0;
  private disabled = false;
  private startupFailures = 0;

  /** RGBA framebuffer → 2x downsampled JPEG. */
  async encode(pixels: Buffer, width: number, height: number, quality: number): Promise<Buffer> {
    const slot = this.pickSlot();
    if (!slot) return encodeInline(pixels, width, height, quality);

    const id = this.nextId++;
    // Pixels are copied (structured clone, a few ms for ~10 MB), not transferred: the
    // caller keeps a usable buffer for the inline fallback if this worker dies mid-task.
    const view = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const task: JpegTask = { id, pixels: view, width, height, quality };

    return new Promise<Buffer>((resolve, reject) => {
      slot.busy.set(id, { resolve, reject });
      slot.worker.postMessage(task);
    });
  }

  private pickSlot(): Slot | null {
    if (this.disabled) return null;
    try {
      while (this.slots.length < POOL_SIZE) this.slots.push(this.spawn());
    } catch {
      this.disabled = true; // e.g. worker file missing — fall back to inline encoding
      return null;
    }
    // Least-loaded slot, round-robin between equals.
    let best = this.slots[this.next++ % this.slots.length];
    for (const s of this.slots) if (s.busy.size < best.busy.size) best = s;
    return best;
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_FILE);
    const slot: Slot = { worker, busy: new Map(), replied: false };

    worker.on('message', (msg: JpegResult) => {
      slot.replied = true;
      const p = slot.busy.get(msg.id);
      if (!p) return;
      slot.busy.delete(msg.id);
      if (msg.jpeg) p.resolve(Buffer.from(msg.jpeg.buffer, msg.jpeg.byteOffset, msg.jpeg.byteLength));
      else p.reject(new Error(msg.error ?? 'jpeg worker failed'));
    });

    const fail = (err: Error) => {
      for (const p of slot.busy.values()) p.reject(err);
      slot.busy.clear();
      this.slots = this.slots.filter((s) => s !== slot); // replaced lazily on next encode
      if (!slot.replied && ++this.startupFailures >= MAX_STARTUP_FAILURES) this.disabled = true;
    };
    worker.on('error', fail);
    worker.on('exit', (code) => { if (code !== 0) fail(new Error(`jpeg worker exited with code ${code}`)); });
    // Never keep the process alive on its own. Must come after the listeners above:
    // adding a 'message' listener re-refs the worker's port.
    worker.unref();
    return slot;
  }
}

function encodeInline(pixels: Buffer, width: number, height: number, quality: number): Buffer {
  const down = downsample2x(pixels, width, height);
  return encodeJpeg(down.data, down.width, down.height, quality);
}

export const jpegPool = new JpegPool();

/** Pool encode, falling back to the main thread if the worker path fails. */
export async function encodeFrameJpeg(pixels: Buffer, width: number, height: number, quality = 65): Promise<Buffer> {
  try {
    return await jpegPool.encode(pixels, width, height, quality);
  } catch {
    return encodeInline(pixels, width, height, quality);
  }
}

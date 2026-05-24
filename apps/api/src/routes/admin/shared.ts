/**
 * Shared utilities for admin routes.
 */
import { deflateSync } from 'node:zlib';
import { z } from 'zod';
import { db } from '../../lib/db';

// ── Minimal PNG generator (no external deps) ─────────────────────────────────

function crc32png(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32png(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** Generate a solid-color PNG (RGB) of given dimensions. */
export function solidPng(w: number, h: number, r: number, g: number, b: number): Buffer {
  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(h * rowLen);
  for (let y = 0; y < h; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

export const Pagination = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ── Helper: write audit entry ─────────────────────────────────────────────────
export async function audit(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string,
  ipAddress: string,
  opts: { before?: unknown; after?: unknown; note?: string } = {}
) {
  await db.adminAuditLog.create({
    data: {
      adminId,
      action,
      targetType,
      targetId,
      before: opts.before as any,
      after:  opts.after  as any,
      ipAddress,
    },
  });
}

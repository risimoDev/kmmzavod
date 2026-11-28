import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function authenticatorCode(seed: string, now = Date.now()): string {
  const normalized = seed.toUpperCase().replace(/\s/g, '').replace(/=+$/, '');
  if (!/^[A-Z2-7]{16,256}$/.test(normalized)) throw new Error('Неверный ключ приложения-аутентификатора');
  const key = Buffer.alloc(Math.floor(normalized.length * 5 / 8));
  let bits = 0, value = 0, offset = 0;
  for (const ch of normalized) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      key[offset++] = value >>> bits;
    }
  }
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) throw new Error('Неверный ключ приложения-аутентификатора');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hash = createHmac('sha1', key).update(counter).digest();
  return String((hash.readUInt32BE(hash[hash.length - 1] & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

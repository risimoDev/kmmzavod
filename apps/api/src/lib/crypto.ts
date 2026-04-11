/**
 * AES-256-GCM encryption for sensitive data at rest (e.g. social account tokens).
 *
 * When ENCRYPTION_KEY is set, tokens are encrypted before storing in DB
 * and decrypted when read. Format: base64(iv + authTag + ciphertext).
 *
 * When ENCRYPTION_KEY is not set, data passes through unmodified (dev mode).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer | null {
  if (!config.ENCRYPTION_KEY) return null;
  return Buffer.from(config.ENCRYPTION_KEY, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // iv (12) + authTag (16) + ciphertext
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decrypt(encoded: string): string {
  const key = getKey();
  if (!key) return encoded;

  // Try to decode — if it fails, assume it's a legacy plaintext value
  let buf: Buffer;
  try {
    buf = Buffer.from(encoded, 'base64');
  } catch {
    return encoded;
  }

  // Minimum length check: iv + authTag = 28 bytes
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    return encoded; // legacy plaintext
  }

  try {
    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    // Decryption failed — likely legacy plaintext token
    return encoded;
  }
}

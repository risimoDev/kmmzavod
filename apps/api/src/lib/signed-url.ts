/**
 * HMAC-signed, expiring capability tokens for URLs that must be fetched
 * without a JWT (e.g. the device-agent downloading an uploaded APK).
 *
 * sig = hex(HMAC-SHA256(JWT_SECRET, "<purpose>\n<value>\n<exp>"))
 * The purpose string keeps signatures from one use case valid only for it.
 */
import crypto from 'node:crypto';
import { config } from '../config';

function hmac(purpose: string, value: string, exp: number): string {
  return crypto
    .createHmac('sha256', config.JWT_SECRET)
    .update(`${purpose}\n${value}\n${exp}`)
    .digest('hex');
}

export function signValue(purpose: string, value: string, ttlSec: number): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return { exp, sig: hmac(purpose, value, exp) };
}

export function verifySignedValue(purpose: string, value: string, exp: unknown, sig: unknown): boolean {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now() / 1000) return false;
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = hmac(purpose, value, expNum);
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Cryptographically signed OAuth state parameter.
 *
 * Prevents CSRF and state-forgery attacks by HMAC-signing the payload
 * with JWT_SECRET. Callbacks verify the signature before trusting tenantId.
 */
import crypto from 'node:crypto';
import { config } from '../config';

const ALGORITHM = 'sha256';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface OAuthStatePayload {
  tenantId: string;
  userId: string;
  /** ISO timestamp of creation (used for TTL check) */
  ts: string;
}

/**
 * Create a signed OAuth state string (base64url).
 * Format: base64url(JSON payload) + "." + hex(HMAC-SHA256 signature)
 */
export function createOAuthState(tenantId: string, userId: string): string {
  const payload: OAuthStatePayload = {
    tenantId,
    userId,
    ts: new Date().toISOString(),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = hmacSign(data);
  return `${data}.${signature}`;
}

/**
 * Verify and decode an OAuth state string.
 * Throws if signature is invalid or state has expired.
 */
export function verifyOAuthState(state: string): { tenantId: string; userId: string } {
  if (!state || !state.includes('.')) {
    throw new Error('Invalid OAuth state format');
  }

  const [data, signature] = state.split('.');
  if (!data || !signature) {
    throw new Error('Invalid OAuth state format');
  }

  // Verify HMAC signature
  const expectedSig = hmacSign(data);
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
    throw new Error('OAuth state signature verification failed');
  }

  // Decode payload
  const payload: OAuthStatePayload = JSON.parse(Buffer.from(data, 'base64url').toString());

  // Check TTL
  const age = Date.now() - new Date(payload.ts).getTime();
  if (age > STATE_TTL_MS) {
    throw new Error('OAuth state expired');
  }

  return { tenantId: payload.tenantId, userId: payload.userId };
}

function hmacSign(data: string): string {
  return crypto
    .createHmac(ALGORITHM, config.JWT_SECRET)
    .update(data)
    .digest('hex');
}

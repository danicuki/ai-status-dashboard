import { createSign } from 'node:crypto';

/** Decode a JWT payload without verifying it (we only read our own tokens' expiry/claims). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    return null;
  }
}

export function signJwtRs256(payload: object, privateKeyPem: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKeyPem).toString('base64url');
  return `${input}.${signature}`;
}

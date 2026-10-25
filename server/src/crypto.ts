// Encryption at rest for third-party tokens (AES-256-GCM) and signed, expiring OAuth state.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const keyFor = (secret: string, purpose: string) => createHash('sha256').update(`${purpose}:${secret}`).digest();

export function encrypt(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(secret, 'enc'), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function decrypt(secret: string, token: string): string {
  const buf = Buffer.from(token, 'base64url');
  const d = createDecipheriv('aes-256-gcm', keyFor(secret, 'enc'), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export function signState(secret: string, data: Record<string, unknown>, ttlSec = 900): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSec, n: randomBytes(6).toString('hex') })).toString('base64url');
  const sig = createHmac('sha256', keyFor(secret, 'state')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState(secret: string, state: string): Record<string, any> | null {
  const [body, sig] = String(state).split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', keyFor(secret, 'state')).update(body).digest('base64url');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return data.exp > Date.now() / 1000 ? data : null;
}

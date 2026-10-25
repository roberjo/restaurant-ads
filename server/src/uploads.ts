// Creative uploads: content-sniffed, size-limited, stored on local disk (object storage in Phase 2).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError } from './http.ts';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function sniff(buf: Buffer): { ext: string; type: 'image' | 'video' } | null {
  const hex = buf.subarray(0, 4).toString('hex');
  if (hex === '89504e47') return { ext: '.png', type: 'image' };
  if (hex.startsWith('ffd8ff')) return { ext: '.jpg', type: 'image' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: '.webp', type: 'image' };
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return { ext: '.mp4', type: 'video' };
  if (hex === '1a45dfa3') return { ext: '.webm', type: 'video' };
  return null;
}

export function saveUpload(uploadsDir: string, dataBase64: unknown): { url: string; type: 'image' | 'video' } {
  if (typeof dataBase64 !== 'string' || !dataBase64) throw new HttpError(400, 'dataBase64 required');
  const buf = Buffer.from(dataBase64.replace(/^data:[^,]*,/, ''), 'base64');
  if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'file too large (max 20 MB)');
  const kind = sniff(buf);
  if (!kind) throw new HttpError(400, 'unsupported file type (use PNG, JPEG, WebP, MP4 or WebM)');
  mkdirSync(uploadsDir, { recursive: true });
  const name = randomBytes(12).toString('hex') + kind.ext;
  writeFileSync(join(uploadsDir, name), buf);
  return { url: `/uploads/${name}`, type: kind.type };
}

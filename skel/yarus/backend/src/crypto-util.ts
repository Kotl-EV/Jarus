import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'crypto';

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || 'yarus-dev-key-change-me';
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(packed: string): string {
  if (!packed) return '';
  const buf = Buffer.from(packed, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function derivePin(pin: string, salt: string): string {
  return scryptSync(pin, salt, 32).toString('hex');
}

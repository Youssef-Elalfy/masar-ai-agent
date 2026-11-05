import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

/**
 * Field-level encryption for contact details (AES-256-GCM, random 96-bit IV per value).
 * The key lives only in the server environment (PII_ENCRYPTION_KEY, 32 bytes base64), never in the DB.
 */
export class PiiCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('PII_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }

  /** Throws if the value was tampered with or encrypted under another key. */
  decrypt(stored: string): string {
    if (!stored.startsWith(PREFIX)) throw new Error('Value is not encrypted with PiiCipher v1.');
    const [iv, tag, ct] = stored.slice(PREFIX.length).split(':');
    if (!iv || !tag || !ct) throw new Error('Malformed encrypted value.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  }
}

export function isEncrypted(value: string | null): boolean {
  return value !== null && value.startsWith(PREFIX);
}

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

// Encryption for stored personal data: AES-256-GCM, with the key kept outside the repo (secrets.env).
// A copied database file is unreadable without it. Losing the key means losing the saved twins.
const VERSION = 'v1';
const derive = (key, purpose) => createHmac('sha256', key).update(`future-self:${purpose}`).digest();

export function newDataKey() {
  return randomBytes(32).toString('base64');
}

export function createCryptoBox(keyText = process.env.DATA_ENCRYPTION_KEY) {
  const key = Buffer.from(typeof keyText === 'string' ? keyText.trim() : '', 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 random bytes in base64. Run npm.cmd run init:storage.');
  // Separate subkeys: one encrypts, one makes stable lookup hashes (e.g. for emails).
  const sealKey = derive(key, 'seal'), lookupKey = derive(key, 'lookup');
  return Object.freeze({
    // `context` (e.g. the row's user ID) is authenticated, so a ciphertext cannot be moved to another row.
    seal(value, context = '') {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', sealKey, iv);
      cipher.setAAD(Buffer.from(context));
      const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
    },
    open(text, context = '') {
      if (typeof text !== 'string' || !text.startsWith(`${VERSION}.`)) throw new Error('Unreadable stored data.');
      const raw = Buffer.from(text.slice(VERSION.length + 1), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', sealKey, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(raw.subarray(12, 28));
      try { return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')); }
      catch { throw new Error('Stored data failed its integrity check.'); }
    },
    lookup(text) {
      return createHmac('sha256', lookupKey).update(text).digest('hex');
    }
  });
}

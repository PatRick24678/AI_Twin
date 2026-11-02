import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, requireThat } from './domain.mjs';

// Email + password accounts. Passwords are only ever stored as scrypt hashes; login sessions are random
// IDs in an HttpOnly cookie, stored as SHA-256 hashes. Error messages never reveal whether an email exists.
const derive = promisify(scrypt);
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
export const AUTH = Object.freeze({
  cookie: 'fs_session', idleMs: 30 * 60 * 1000, absoluteMs: 12 * 60 * 60 * 1000,
  failures: 5, lockMs: 15 * 60 * 1000, consentVersion: '2026-11-02'
});
// A short deny-list; length is the main defence. Hosted versions should also check breached-password lists.
const COMMON = new Set(['password1234', '123456789012', 'qwertyuiopas', 'welcome12345', 'letmein12345', 'iloveyou1234',
  'passwordpassword', 'changeme1234', 'futureself123', 'tatoma123456', 'admin1234567', '000000000000', '111111111111']);

export function checkEmail(value) {
  requireThat(typeof value === 'string', 'Enter an email address.');
  const email = value.trim().toLowerCase();
  requireThat(email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid email address.');
  return email;
}

export function checkPassword(password, email = '') {
  requireThat(typeof password === 'string' && password.length >= 12 && password.length <= 128,
    'Use a password of 12 to 128 characters. A short sentence works well.');
  const lower = password.toLowerCase();
  requireThat(!COMMON.has(lower) && !/^(.)\1+$/.test(password) && lower !== email && lower !== email.split('@')[0],
    'Choose a less predictable password.');
  return password;
}

export async function hashPassword(password) {
  const salt = randomBytes(16), hash = await derive(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// A fixed decoy hash keeps the timing similar when the email is unknown.
const DECOY = await hashPassword(randomBytes(18).toString('base64'));
export async function verifyPassword(password, stored = DECOY) {
  const [kind, N, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || typeof password !== 'string' || password.length > 128) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return stored !== DECOY && timingSafeEqual(actual, expected);
}

export const newSessionId = () => randomBytes(32).toString('base64url');
export const hashToken = value => createHash('sha256').update(value).digest('hex');

// One-time reset codes: easy to read out (no 0/O or 1/I), stored only as a hash, compared in constant time.
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newResetCode() {
  const code = Array.from({ length: 10 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
const normalCode = value => typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
export function sameCode(code, storedHash) {
  const given = Buffer.from(hashToken(`${normalCode(code).slice(0, 5)}-${normalCode(code).slice(5)}`)), stored = Buffer.from(String(storedHash));
  return given.length === stored.length && timingSafeEqual(given, stored);
}

export function readCookie(header = '', name = AUTH.cookie) {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}
// Secure is added once the app runs over HTTPS (hosted); locally it is plain http://127.0.0.1.
export function sessionCookie(value, { secure = process.env.FUTURE_SELF_SECURE_COOKIES === '1', clear = false } = {}) {
  return [`${AUTH.cookie}=${clear ? '' : value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/',
    `Max-Age=${clear ? 0 : AUTH.absoluteMs / 1000}`, ...(secure ? ['Secure'] : [])].join('; ');
}

// Slows password guessing: after five failures for the same email (or address) wait 15 minutes.
export function createThrottle(now = () => Date.now()) {
  const failures = new Map();
  return {
    check(...keys) {
      for (const key of keys) {
        const entry = failures.get(key);
        if (entry && entry.count >= AUTH.failures && now() - entry.at < AUTH.lockMs) {
          throw new AppError(429, 'Too many attempts. Wait 15 minutes, then try again.');
        }
      }
    },
    fail(...keys) {
      for (const key of keys) {
        const entry = failures.get(key);
        const fresh = !entry || now() - entry.at >= AUTH.lockMs;
        failures.set(key, { count: fresh ? 1 : entry.count + 1, at: now() });
      }
    },
    succeed: (...keys) => keys.forEach(key => failures.delete(key))
  };
}

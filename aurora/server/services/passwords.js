import crypto from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const derived = crypto.scryptSync(password, salt, KEYLEN);
    const expected = Buffer.from(hash, 'hex');
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function validatePasswordStrength(pw) {
  const errors = [];
  if (pw.length < 8) errors.push('Password must be at least 8 characters');
  if (pw.length > 128) errors.push('Password must be at most 128 characters');
  if (!/[a-z]/.test(pw)) errors.push('Include at least one lowercase letter');
  if (!/[A-Z]/.test(pw)) errors.push('Include at least one uppercase letter');
  if (!/[0-9]/.test(pw)) errors.push('Include at least one number');
  const common = ['password', '12345678', 'qwerty', 'aurora123', 'letmein', 'welcome1'];
  if (common.some((c) => pw.toLowerCase().includes(c))) errors.push('Password is too common');
  return { ok: errors.length === 0, errors, score: scorePassword(pw) };
}

export function scorePassword(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 5);
}

export const sha256 = (str) => crypto.createHash('sha256').update(str).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const uuid = () => crypto.randomUUID();

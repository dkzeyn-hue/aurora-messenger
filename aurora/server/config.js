import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const dataDir = path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Persist a generated JWT secret so sessions survive restarts
const secretFile = path.join(dataDir, '.jwt-secret');
let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (fs.existsSync(secretFile)) jwtSecret = fs.readFileSync(secretFile, 'utf8');
  else {
    jwtSecret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, jwtSecret, { mode: 0o600 });
  }
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  dbPath: process.env.DB_PATH || path.join(dataDir, 'aurora.db'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(ROOT, 'uploads'),
  jwtSecret,
  accessTokenTtl: '15m',
  refreshTokenTtlDays: 30,
  // EMAIL_MODE=dev stores emails in an in-app dev inbox (no SMTP available in sandbox).
  // Set EMAIL_MODE=smtp + SMTP_* to wire a real provider in production.
  emailMode: process.env.EMAIL_MODE || 'dev',
  emailFrom: process.env.EMAIL_FROM || 'Aurora <no-reply@aurora.app>',
  appName: 'Aurora',
  maxUploadMB: parseInt(process.env.MAX_UPLOAD_MB || '64', 10),
  baseUrl: process.env.BASE_URL || '',
};

fs.mkdirSync(config.uploadsDir, { recursive: true });

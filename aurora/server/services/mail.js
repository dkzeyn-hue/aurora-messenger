import { config } from '../config.js';
import { run } from '../db/index.js';
import { createEmailToken } from './tokens.js';

/**
 * Mail service.
 * - EMAIL_MODE=dev (default in this environment, no SMTP available):
 *   emails are stored in an in-app dev inbox (GET /api/dev/emails) and the
 *   verification/reset links are surfaced by the client automatically.
 * - EMAIL_MODE=smtp: plug in nodemailer transport via SMTP_* env vars in production.
 */

async function deliver(to, subject, body, link, code) {
  if (config.emailMode === 'smtp') {
    try {
      const nodemailer = (await import('nodemailer')).default;
      if (!globalThis.__transport) {
        globalThis.__transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        });
      }
      await globalThis.__transport.sendMail({ from: config.emailFrom, to, subject, text: body, html: body.replace(/\n/g, '<br>') });
      return;
    } catch (e) {
      console.error('[mail] SMTP delivery failed, falling back to dev inbox:', e.message);
    }
  }
  run(`INSERT INTO dev_emails(to_email,subject,body,link,code) VALUES(?,?,?,?,?)`, to, subject, body, link || null, code || null);
  console.log(`[mail:dev] → ${to} :: ${subject} :: link=${link || '-'} code=${code || '-'}`);
}

export function appUrl(pathStr) {
  return (config.baseUrl || '') + pathStr;
}

export async function sendVerification(userId, email) {
  const token = createEmailToken(userId, 'verify', 60 * 24);
  const link = appUrl(`/verify/${token}`);
  await deliver(
    email,
    'Verify your Aurora email',
    `Welcome to Aurora!\n\nConfirm your email address to activate your account:\n${link}\n\nOr enter this code in the app: ${token.slice(0, 8).toUpperCase()}\n\nThis link expires in 24 hours. If you didn't create an account, ignore this email.`,
    link,
    token.slice(0, 8).toUpperCase()
  );
}

export async function sendPasswordReset(userId, email) {
  const token = createEmailToken(userId, 'reset', 30);
  const link = appUrl(`/reset/${token}`);
  await deliver(
    email,
    'Reset your Aurora password',
    `We received a request to reset your password.\n\n${link}\n\nOr enter this code in the app: ${token.slice(0, 8).toUpperCase()}\n\nThis link expires in 30 minutes. If you didn't request this, your account is safe — but consider changing your password.`,
    link,
    token.slice(0, 8).toUpperCase()
  );
}

export async function sendNewDeviceAlert(email, device, ip) {
  await deliver(
    email,
    'New sign-in to your Aurora account',
    `Your account was just used to sign in.\n\nDevice: ${device}\nIP: ${ip}\nTime: ${new Date().toUTCString()}\n\nIf this wasn't you, change your password immediately and use Settings → Security → Log out all devices.`
  );
}

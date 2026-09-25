import express from 'express';
import { all } from '../db/index.js';
import { config } from '../config.js';

export const devMailRouter = express.Router();

/**
 * Demo-environment inbox. EMAIL_MODE=dev only.
 * In production with real SMTP this router is disabled entirely.
 */
devMailRouter.get('/emails', (req, res) => {
  if (config.emailMode !== 'dev') return res.status(404).json({ error: 'disabled', message: 'Dev inbox disabled' });
  const to = req.query.to ? String(req.query.to).toLowerCase() : null;
  const rows = all(
    `SELECT id, to_email, subject, body, link, code, created_at FROM dev_emails
     ${to ? 'WHERE lower(to_email)=?' : ''} ORDER BY id DESC LIMIT 20`,
    to ? [to] : []
  );
  res.json({
    emails: rows.map((r) => ({
      id: r.id, to: r.to_email, subject: r.subject, body: r.body,
      link: r.link, code: r.code, createdAt: r.created_at,
    })),
  });
});

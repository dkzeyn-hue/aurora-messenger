import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { run, get } from '../db/index.js';

/**
 * Storage abstraction (S3-compatible interface over local disk).
 * Swap `putObject` for an S3 PutObject call in production without touching routes.
 */

const ALLOWED = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm'],
  voice: ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'],
  document: [
    'application/pdf', 'text/plain', 'application/zip', 'application/json',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
    'audio/mpeg', 'audio/ogg', 'audio/wav',
  ],
  avatar: ['image/jpeg', 'image/png', 'image/webp'],
};
const MAX_BYTES = { avatar: 5, image: 25, video: 200, audio: 50, voice: 25, document: 100 };

export function validateUpload(kind, mime, sizeMB) {
  const allowed = ALLOWED[kind] || ALLOWED.document;
  if (!allowed.includes(mime)) return { ok: false, error: `File type ${mime} is not allowed for ${kind}` };
  const max = Math.min(MAX_BYTES[kind] ?? 100, config.maxUploadMB);
  if (sizeMB > max) return { ok: false, error: `File too large (max ${max} MB for ${kind})` };
  return { ok: true };
}

export function putObject(buffer, mime, kind) {
  const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9.+-]/gi, '').slice(0, 8);
  const sub = path.join(String(new Date().getFullYear()), String(new Date().getMonth() + 1).padStart(2, '0'));
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  const rel = path.join(sub, name);
  const abs = path.join(config.uploadsDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return rel.split(path.sep).join('/');
}

export function absolutePath(rel) {
  // guard against path traversal
  const abs = path.resolve(config.uploadsDir, rel);
  if (!abs.startsWith(path.resolve(config.uploadsDir))) return null;
  return abs;
}

export function removeObject(rel) {
  try { const abs = absolutePath(rel); if (abs) fs.unlinkSync(abs); } catch {}
}

/** Save an uploaded file + DB row. thumbBuffer optional (client-generated thumbnail). */
export function saveAttachment({ ownerId, kind, mime, filename, buffer, thumbBuffer, meta = {} }) {
  const rel = putObject(buffer, mime, kind);
  let thumbRel = null;
  if (thumbBuffer) thumbRel = putObject(thumbBuffer, 'image/jpeg', 'avatar');
  const info = run(
    `INSERT INTO attachments(owner_id,kind,mime,filename,size,path,thumb_path,width,height,duration,waveform)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ownerId, kind, mime, filename || '', buffer.length, rel, thumbRel,
    meta.width || null, meta.height || null, meta.duration || null,
    meta.waveform ? JSON.stringify(meta.waveform) : null
  );
  return get(`SELECT * FROM attachments WHERE id=?`, info.lastInsertRowid);
}

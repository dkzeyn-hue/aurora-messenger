import express from 'express';
import multer from 'multer';
import { get, run, all } from '../db/index.js';
import { config } from '../config.js';
import { authenticate, requireVerifiedEmail, fail, clientIp } from '../middleware/auth.js';
import { saveAttachment, validateUpload, absolutePath, removeObject } from '../services/storage.js';
import { serializeAttachment, serializeStory, serializeUser } from '../services/serialize.js';
import { uploadLimiter } from '../services/ratelimit.js';
import { canSeeStory, membership, requireChatAccess, canSeeProfilePhoto } from '../services/access.js';
import { verifyAccessToken } from '../services/tokens.js';
import { toUser, toUsers, contactsOf, createNotification, getIO } from '../services/realtime.js';
import path from 'node:path';
import fs from 'node:fs';

export const filesRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMB * 1024 * 1024 + 1024 * 1024, files: 3 },
});

// ---- upload ---------------------------------------------------------------------
filesRouter.post('/uploads', authenticate(), requireVerifiedEmail, uploadLimiter, upload.fields([
  { name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 },
]), (req, res) => {
  const file = req.files?.file?.[0];
  if (!file) return fail(res, 400, 'no_file', 'No file received');
  const kind = ['image', 'video', 'voice', 'audio', 'document', 'avatar', 'story'].includes(req.body?.kind) ? req.body.kind : 'document';
  // normalize story media kinds for validation
  const validateKind = kind === 'story' ? (file.mimetype.startsWith('video') ? 'video' : 'image') : kind === 'avatar' ? 'avatar' : kind;
  const sizeMB = file.size / 1048576;
  const v = validateUpload(validateKind, file.mimetype, sizeMB);
  if (!v.ok) return fail(res, 400, 'invalid_file', v.error);

  let meta = {};
  try { meta = JSON.parse(req.body?.meta || '{}'); } catch {}
  if (meta.duration && (+meta.duration > 600 || +meta.duration < 0)) return fail(res, 400, 'invalid_meta', 'Invalid duration');
  const waveform = Array.isArray(meta.waveform) ? meta.waveform.slice(0, 200).map((x) => Math.max(0, Math.min(1, +x || 0))) : null;

  const thumb = req.files?.thumb?.[0];
  if (thumb && (!thumb.mimetype.startsWith('image/') || thumb.size > 1024 * 1024)) return fail(res, 400, 'invalid_thumb', 'Invalid thumbnail');

  const att = saveAttachment({
    ownerId: req.user.id, kind, mime: file.mimetype, filename: (file.originalname || '').slice(0, 180),
    buffer: file.buffer, thumbBuffer: thumb?.buffer || null,
    meta: { width: +meta.width || null, height: +meta.height || null, duration: +meta.duration || null, waveform },
  });
  res.status(201).json({ attachment: serializeAttachment(att, req.user) });
});

// ---- download / stream (authorization enforced per file) ---------------------------
function canAccessAttachment(user, att) {
  if (!user) return att.kind === 'avatar'; // avatars of public profiles: still gate behind login for privacy; allow anonymous only for public channel thumbs? keep login required
  if (att.owner_id === user.id) return true;
  if (user.role === 'admin') return true;
  if (att.kind === 'avatar') {
    const owner = get(`SELECT * FROM users WHERE id=?`, att.owner_id);
    if (!owner) return false;
    return canSeeProfilePhoto(user, owner);
  }
  // story media
  const story = get(`SELECT * FROM stories WHERE attachment_id=?`, att.id);
  if (story) return canSeeStory(user, story);
  // chat media: must be a member of a chat where this attachment was used
  const used = get(
    `SELECT m.chat_id FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=?
     WHERE m.attachment_id=? LIMIT 1`, user.id, att.id
  );
  return !!used;
}

filesRouter.get('/files/:id', authenticate(false), (req, res, next) => {
  const att = get(`SELECT * FROM attachments WHERE id=?`, +req.params.id);
  if (!att) return res.status(404).send('Not found');
  // inline auth via ?token= (media tags cannot send headers)
  let user = req.user;
  if (!user && req.query.token) {
    const payload = verifyAccessToken(String(req.query.token));
    if (payload) user = get(`SELECT * FROM users WHERE id=? AND suspended=0`, payload.sub);
  }
  if (!user) return res.status(401).send('Sign in to view this file');
  if (!canAccessAttachment(user, att)) return res.status(403).send('You do not have access to this file');

  const isThumb = req.query.thumb === '1' && att.thumb_path;
  const rel = isThumb ? att.thumb_path : att.path;
  const abs = absolutePath(rel);
  if (!abs || !fs.existsSync(abs)) return res.status(404).send('File missing');
  const mime = isThumb ? 'image/jpeg' : att.mime;
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    // support range requests for seeking
    const stat = fs.statSync(abs);
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size) { res.status(416).end(); return; }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(abs, { start, end }).pipe(res);
      return;
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', stat.size);
  }
  res.sendFile(abs);
});

// ---- stories ------------------------------------------------------------------------
export const storiesRouter = express.Router();
storiesRouter.use(authenticate(), requireVerifiedEmail);

storiesRouter.post('/', (req, res) => {
  const { attachmentId, caption, overlay, privacy, selectedUsers, expiresInHours } = req.body || {};
  const att = get(`SELECT * FROM attachments WHERE id=? AND owner_id=? AND kind='story'`, +attachmentId, req.user.id);
  if (!att) return fail(res, 400, 'invalid_media', 'Upload a photo or video for your story first');
  if (!['everyone', 'contacts', 'selected', 'nobody'].includes(privacy)) return fail(res, 400, 'invalid_privacy', 'Invalid story privacy');
  const hours = Math.max(1, Math.min(168, +expiresInHours || 24));
  const expires = new Date(Date.now() + hours * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  let selected = '[]';
  if (privacy === 'selected') {
    const arr = (selectedUsers || []).map(Number).filter(Boolean).slice(0, 200);
    if (!arr.length) return fail(res, 400, 'empty_selection', 'Select at least one viewer');
    selected = JSON.stringify(arr);
  }
  const info = run(
    `INSERT INTO stories(user_id,attachment_id,caption,overlay,privacy,selected_users,expires_at) VALUES(?,?,?,?,?,?,?)`,
    req.user.id, att.id, String(caption || '').slice(0, 500), JSON.stringify(overlay || []).slice(0, 20000), privacy, selected, expires
  );
  const story = get(`SELECT * FROM stories WHERE id=?`, info.lastInsertRowid);
  const payload = serializeStory(story, req.user);
  // push to eligible viewers (contacts approximation = direct chat peers) + everyone if public
  const peers = contactsOf(req.user.id);
  toUsers(peers, 'story:new', payload);
  res.status(201).json({ story: payload });
});

storiesRouter.get('/feed', (req, res) => {
  const active = all(`SELECT * FROM stories WHERE expires_at > datetime('now') ORDER BY created_at DESC LIMIT 300`);
  const byUser = new Map();
  let mine = [];
  for (const s of active) {
    if (!canSeeStory(req.user, s)) continue;
    const serialized = serializeStory(s, req.user);
    if (s.user_id === req.user.id) { mine.push(serialized); continue; }
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id).push(serialized);
  }
  const groups = [...byUser.entries()].map(([uid, stories]) => ({ user: stories[0].user, stories })).slice(0, 60);
  res.json({ mine, groups });
});

storiesRouter.get('/user/:id', (req, res) => {
  const uid = +req.params.id;
  const target = get(`SELECT * FROM users WHERE id=?`, uid);
  if (!target) return fail(res, 404, 'not_found', 'User not found');
  const rows = uid === req.user.id
    ? all(`SELECT * FROM stories WHERE user_id=? ORDER BY created_at DESC LIMIT 100`, uid)
    : all(`SELECT * FROM stories WHERE user_id=? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 100`, uid);
  const stories = rows.filter((s) => canSeeStory(req.user, s)).map((s) => serializeStory(s, req.user));
  res.json({ user: serializeUser(target, req.user), stories });
});

storiesRouter.get('/:id', (req, res) => {
  const story = get(`SELECT * FROM stories WHERE id=?`, +req.params.id);
  if (!story) return fail(res, 404, 'not_found', 'Story not found or expired');
  if (story.expires_at <= new Date().toISOString().replace('T', ' ').slice(0, 19) && story.user_id !== req.user.id)
    return fail(res, 410, 'expired', 'This story has expired');
  if (!canSeeStory(req.user, story)) return fail(res, 403, 'forbidden', 'You are not allowed to view this story');
  res.json({ story: serializeStory(story, req.user) });
});

storiesRouter.post('/:id/view', (req, res) => {
  const story = get(`SELECT * FROM stories WHERE id=?`, +req.params.id);
  if (!story) return fail(res, 404, 'not_found', 'Story not found');
  if (!canSeeStory(req.user, story)) return fail(res, 403, 'forbidden', 'Not allowed');
  if (story.user_id !== req.user.id) {
    run(`INSERT OR IGNORE INTO story_views(story_id,viewer_id) VALUES(?,?)`, story.id, req.user.id);
    const owner = get(`SELECT display_name FROM users WHERE id=?`, req.user.id);
    toUser(story.user_id, 'story:viewed', { storyId: story.id, viewer: serializeUser(req.user, req.user) });
  }
  res.json({ ok: true });
});

storiesRouter.post('/:id/react', (req, res) => {
  const story = get(`SELECT * FROM stories WHERE id=?`, +req.params.id);
  if (!story) return fail(res, 404, 'not_found', 'Story not found');
  if (!canSeeStory(req.user, story)) return fail(res, 403, 'forbidden', 'Not allowed');
  if (story.user_id === req.user.id) return fail(res, 400, 'self', 'You cannot react to your own story');
  const emoji = String(req.body?.emoji || '❤️');
  run(`INSERT INTO story_views(story_id,viewer_id,reaction) VALUES(?,?,?)
       ON CONFLICT(story_id,viewer_id) DO UPDATE SET reaction=excluded.reaction`, story.id, req.user.id, emoji);
  toUser(story.user_id, 'story:reaction', { storyId: story.id, emoji, viewer: serializeUser(req.user, req.user) });
  createNotification(story.user_id, { type: 'story_reaction', storyId: story.id, actorId: req.user.id, title: `${req.user.display_name} reacted ${emoji} to your story`, body: story.caption || '' });
  res.json({ ok: true });
});

storiesRouter.get('/:id/viewers', (req, res) => {
  const story = get(`SELECT * FROM stories WHERE id=?`, +req.params.id);
  if (!story) return fail(res, 404, 'not_found', 'Story not found');
  if (story.user_id !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'forbidden', 'Only the author can see viewers');
  const viewers = all(
    `SELECT u.*, sv.reaction, sv.viewed_at FROM story_views sv JOIN users u ON u.id=sv.viewer_id WHERE sv.story_id=? ORDER BY sv.viewed_at DESC`, story.id
  );
  res.json({ viewers: viewers.map((v) => ({ ...serializeUser(v, req.user), reaction: v.reaction, viewedAt: v.viewed_at })) });
});

storiesRouter.delete('/:id', (req, res) => {
  const story = get(`SELECT * FROM stories WHERE id=?`, +req.params.id);
  if (!story) return fail(res, 404, 'not_found', 'Story not found');
  if (story.user_id !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'forbidden', 'Only the author can delete a story');
  run(`DELETE FROM story_views WHERE story_id=?`, story.id);
  run(`DELETE FROM stories WHERE id=?`, story.id);
  const att = get(`SELECT * FROM attachments WHERE id=?`, story.attachment_id);
  if (att && att.owner_id === story.user_id) { removeObject(att.path); if (att.thumb_path) removeObject(att.thumb_path); run(`DELETE FROM attachments WHERE id=?`, att.id); }
  getIO()?.emit('story:deleted', { storyId: story.id, userId: story.user_id });
  res.json({ message: 'Story deleted' });
});

// cleanup expired stories hourly
setInterval(() => {
  const expired = all(`SELECT id, attachment_id, user_id FROM stories WHERE expires_at <= datetime('now')`);
  for (const s of expired) {
    run(`DELETE FROM story_views WHERE story_id=?`, s.id);
    const att = get(`SELECT * FROM attachments WHERE id=?`, s.attachment_id);
    if (att) { removeObject(att.path); if (att.thumb_path) removeObject(att.thumb_path); run(`DELETE FROM attachments WHERE id=?`, att.id); }
    run(`DELETE FROM stories WHERE id=?`, s.id);
  }
  if (expired.length) console.log(`[stories] cleaned ${expired.length} expired stories`);
}, 3600_000).unref();

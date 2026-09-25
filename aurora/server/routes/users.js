import express from 'express';
import { get, all, run } from '../db/index.js';
import { authenticate, requireVerifiedEmail, fail, clientIp } from '../middleware/auth.js';
import { serializeUser } from '../services/serialize.js';
import { getSettings } from '../services/access.js';
import { searchLimiter } from '../services/ratelimit.js';
import { toUser } from '../services/realtime.js';

export const usersRouter = express.Router();
usersRouter.use(authenticate(), requireVerifiedEmail);

// ---- my profile ------------------------------------------------------------
usersRouter.get('/me/full', (req, res) => {
  const user = serializeUser(req.user, req.user);
  user.settings = getSettings(req.user.id);
  user.stats = {
    chats: get(`SELECT COUNT(*) c FROM chat_members WHERE user_id=?`, req.user.id).c,
    stories: get(`SELECT COUNT(*) c FROM stories WHERE user_id=? AND expires_at > datetime('now')`, req.user.id).c,
  };
  res.json({ user });
});

usersRouter.patch('/me', (req, res) => {
  const { displayName, bio, username, avatarAttachmentId } = req.body || {};
  if (displayName !== undefined) {
    const dn = String(displayName).trim();
    if (dn.length < 1 || dn.length > 64) return fail(res, 400, 'invalid_name', 'Display name must be 1–64 characters');
    run(`UPDATE users SET display_name=? WHERE id=?`, dn, req.user.id);
  }
  if (bio !== undefined) {
    if (String(bio).length > 280) return fail(res, 400, 'bio_too_long', 'Bio must be under 280 characters');
    run(`UPDATE users SET bio=? WHERE id=?`, String(bio), req.user.id);
  }
  if (username !== undefined && String(username).toLowerCase() !== req.user.username) {
    const u = String(username).toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(u)) return fail(res, 400, 'invalid_username', 'Username must be 3–32 characters: letters, numbers, underscore');
    if (get(`SELECT 1 FROM banned_usernames WHERE username=?`, u)) return fail(res, 400, 'reserved', 'This username is reserved');
    if (get(`SELECT 1 FROM users WHERE username=?`, u)) return fail(res, 409, 'username_taken', 'This username is already taken');
    run(`UPDATE users SET username=? WHERE id=?`, u, req.user.id);
  }
  if (avatarAttachmentId !== undefined) {
    const att = get(`SELECT * FROM attachments WHERE id=? AND owner_id=? AND kind='avatar'`, avatarAttachmentId, req.user.id);
    if (avatarAttachmentId && !att) return fail(res, 400, 'invalid_avatar', 'Invalid avatar file');
    run(`UPDATE users SET avatar_attachment_id=? WHERE id=?`, avatarAttachmentId || null, req.user.id);
  }
  const fresh = get(`SELECT * FROM users WHERE id=?`, req.user.id);
  const payload = serializeUser(fresh, fresh);
  // notify direct-chat peers of the profile change
  for (const peer of all(
    `SELECT DISTINCT cm2.user_id uid FROM chat_members cm1 JOIN chats c ON c.id=cm1.chat_id AND c.type='direct'
     JOIN chat_members cm2 ON cm2.chat_id=c.id WHERE cm1.user_id=? AND cm2.user_id!=?`, req.user.id, req.user.id)) {
    toUser(peer.uid, 'user:updated', payload);
  }
  res.json({ user: payload });
});

usersRouter.patch('/me/settings', (req, res) => {
  const cur = getSettings(req.user.id);
  const { privacy, notifications, appearance, data } = req.body || {};
  const merge = (section, incoming) => JSON.stringify({ ...cur[section], ...(incoming && typeof incoming === 'object' ? incoming : {}) });
  run(
    `UPDATE user_settings SET privacy=?, notifications=?, appearance=?, data=? WHERE user_id=?`,
    merge('privacy', privacy), merge('notifications', notifications), merge('appearance', appearance), merge('data', data),
    req.user.id
  );
  res.json({ settings: getSettings(req.user.id) });
});

// ---- other users -----------------------------------------------------------
function findUser(param) {
  if (/^\d+$/.test(param)) return get(`SELECT * FROM users WHERE id=?`, +param);
  if (param.startsWith('@')) param = param.slice(1);
  return get(`SELECT * FROM users WHERE username=?`, param.toLowerCase());
}

usersRouter.get('/:idOrUsername', (req, res) => {
  const target = findUser(req.params.idOrUsername);
  if (!target || target.suspended) return fail(res, 404, 'user_not_found', 'User not found');
  const mutual = all(
    `SELECT c.id, c.type, c.name, c.avatar_attachment_id FROM chat_members m1
     JOIN chat_members m2 ON m2.chat_id=m1.chat_id AND m2.user_id=?
     JOIN chats c ON c.id=m1.chat_id
     WHERE m1.user_id=? AND c.type IN ('group','channel') LIMIT 20`, req.user.id, target.id
  ).map((c) => ({ id: c.id, type: c.type, name: c.name, avatar: c.avatar_attachment_id ? `/api/files/${c.avatar_attachment_id}` : null }));
  res.json({ user: serializeUser(target, req.user), mutualChats: mutual });
});

usersRouter.get('/search/people', searchLimiter, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = all(
    `SELECT * FROM users
     WHERE suspended=0 AND (username LIKE ? OR display_name LIKE ?)
     ORDER BY CASE WHEN username = ? THEN 0 WHEN username LIKE ? THEN 1 ELSE 2 END, id
     LIMIT 25`,
    like, like, q, q + '%'
  );
  res.json({ results: rows.map((u) => serializeUser(u, req.user)) });
});

// ---- block / mute / report -------------------------------------------------
usersRouter.post('/:id/block', (req, res) => {
  const tid = +req.params.id;
  if (tid === req.user.id) return fail(res, 400, 'self', 'You cannot block yourself');
  if (!get(`SELECT 1 FROM users WHERE id=?`, tid)) return fail(res, 404, 'user_not_found', 'User not found');
  run(`INSERT OR IGNORE INTO blocks(blocker_id,blocked_id) VALUES(?,?)`, req.user.id, tid);
  // remove shared direct chat visibility: archive direct chats with them
  const dm = get(
    `SELECT c.id FROM chats c JOIN chat_members m1 ON m1.chat_id=c.id AND m1.user_id=?
     JOIN chat_members m2 ON m2.chat_id=c.id AND m2.user_id=? WHERE c.type='direct'`, req.user.id, tid);
  if (dm) run(`UPDATE chat_members SET archived=1 WHERE chat_id=? AND user_id=?`, dm.id, req.user.id);
  res.json({ message: 'User blocked' });
});

usersRouter.delete('/:id/block', (req, res) => {
  run(`DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?`, req.user.id, +req.params.id);
  res.json({ message: 'User unblocked' });
});

usersRouter.get('/me/blocks', (req, res) => {
  const rows = all(
    `SELECT u.* FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY b.created_at DESC`, req.user.id
  );
  res.json({ blocked: rows.map((u) => serializeUser(u, req.user)) });
});

usersRouter.post('/report', (req, res) => {
  const { targetType, targetId, reason, details } = req.body || {};
  if (!['user', 'message', 'chat', 'story'].includes(targetType)) return fail(res, 400, 'invalid_target', 'Invalid report target');
  if (!['spam', 'abuse', 'harassment', 'pornography', 'violence', 'scam', 'other'].includes(reason))
    return fail(res, 400, 'invalid_reason', 'Invalid report reason');
  run(
    `INSERT INTO reports(reporter_id,target_type,target_id,reason,details) VALUES(?,?,?,?,?)`,
    req.user.id, targetType, +targetId || 0, reason, String(details || '').slice(0, 1000)
  );
  res.status(201).json({ message: 'Report submitted. Our moderators will review it. Thank you.' });
});

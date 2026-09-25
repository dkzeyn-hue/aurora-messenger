import express from 'express';
import { get, all, run, platformSetting, setPlatformSetting } from '../db/index.js';
import { authenticate, requireAdmin, fail, clientIp } from '../middleware/auth.js';
import { serializeUser, serializeChat } from '../services/serialize.js';
import { kickUser } from '../services/realtime.js';
import { removeObject } from '../services/storage.js';

export const adminRouter = express.Router();
adminRouter.use(authenticate(), requireAdmin);

adminRouter.get('/stats', (req, res) => {
  res.json({
    users: get(`SELECT COUNT(*) c FROM users`).c,
    verifiedUsers: get(`SELECT COUNT(*) c FROM users WHERE email_verified=1`).c,
    suspendedUsers: get(`SELECT COUNT(*) c FROM users WHERE suspended=1`).c,
    onlineNow: get(`SELECT COUNT(*) c FROM users WHERE status='online'`).c,
    newToday: get(`SELECT COUNT(*) c FROM users WHERE created_at > datetime('now','-1 day')`).c,
    chats: get(`SELECT COUNT(*) c FROM chats`).c,
    groups: get(`SELECT COUNT(*) c FROM chats WHERE type='group'`).c,
    channels: get(`SELECT COUNT(*) c FROM chats WHERE type='channel'`).c,
    messages: get(`SELECT COUNT(*) c FROM messages`).c,
    messagesToday: get(`SELECT COUNT(*) c FROM messages WHERE created_at > datetime('now','-1 day')`).c,
    stories: get(`SELECT COUNT(*) c FROM stories WHERE expires_at > datetime('now')`).c,
    attachments: get(`SELECT COUNT(*) c FROM attachments`).c,
    storageMB: Math.round((get(`SELECT COALESCE(SUM(size),0) s FROM attachments`).s) / 1048576),
    openReports: get(`SELECT COUNT(*) c FROM reports WHERE status='open'`).c,
    signupTrend: all(`SELECT date(created_at) d, COUNT(*) c FROM users WHERE created_at > datetime('now','-14 days') GROUP BY d ORDER BY d`),
    messageTrend: all(`SELECT date(created_at) d, COUNT(*) c FROM messages WHERE created_at > datetime('now','-14 days') GROUP BY d ORDER BY d`),
  });
});

adminRouter.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(100, +req.query.limit || 30);
  const offset = +req.query.offset || 0;
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = all(
    `SELECT * FROM users ${q ? `WHERE email LIKE ? OR username LIKE ? OR display_name LIKE ?` : ''}
     ORDER BY id DESC LIMIT ? OFFSET ?`,
    q ? [like, like, like, limit, offset] : [limit, offset]
  );
  res.json({
    users: rows.map((u) => serializeUser(u, u)),
    total: get(`SELECT COUNT(*) c FROM users ${q ? `WHERE email LIKE ? OR username LIKE ? OR display_name LIKE ?` : ''}`, ...(q ? [like, like, like] : [])).c,
  });
});

adminRouter.patch('/users/:id/suspend', (req, res) => {
  const user = get(`SELECT * FROM users WHERE id=?`, +req.params.id);
  if (!user) return fail(res, 404, 'not_found', 'User not found');
  if (user.role === 'admin') return fail(res, 403, 'forbidden', 'Cannot suspend an admin');
  const suspend = !!req.body?.suspend;
  run(`UPDATE users SET suspended=?, suspended_reason=? WHERE id=?`, suspend ? 1 : 0, suspend ? String(req.body?.reason || '').slice(0, 200) : null, user.id);
  if (suspend) kickUser(user.id, 'Account suspended by moderation');
  res.json({ message: suspend ? 'User suspended' : 'User reinstated' });
});

adminRouter.delete('/users/:id', (req, res) => {
  const user = get(`SELECT * FROM users WHERE id=?`, +req.params.id);
  if (!user) return fail(res, 404, 'not_found', 'User not found');
  if (user.role === 'admin') return fail(res, 403, 'forbidden', 'Cannot delete an admin');
  // hard delete: reuse deletion logic inline
  const chatIds = all(`SELECT chat_id FROM chat_members WHERE user_id=?`, user.id).map((r) => r.chat_id);
  for (const cid of chatIds) {
    const chat = get(`SELECT * FROM chats WHERE id=?`, cid);
    if (!chat) continue;
    if (chat.type === 'direct' || chat.owner_id === user.id) {
      for (const m of all(`SELECT id, attachment_id FROM messages WHERE chat_id=?`, cid)) {
        run(`DELETE FROM reactions WHERE message_id=?`, m.id);
        run(`DELETE FROM message_deletions WHERE message_id=?`, m.id);
        run(`DELETE FROM pinned_messages WHERE message_id=?`, m.id);
        if (m.attachment_id) {
          const a = get(`SELECT * FROM attachments WHERE id=?`, m.attachment_id);
          if (a) { removeObject(a.path); if (a.thumb_path) removeObject(a.thumb_path); }
          run(`DELETE FROM attachments WHERE id=?`, m.attachment_id);
        }
      }
      run(`DELETE FROM messages WHERE chat_id=?`, cid);
      run(`DELETE FROM pinned_messages WHERE chat_id=?`, cid);
      run(`DELETE FROM invites WHERE chat_id=?`, cid);
      run(`DELETE FROM chat_members WHERE chat_id=?`, cid);
      run(`DELETE FROM chats WHERE id=?`, cid);
    } else {
      run(`DELETE FROM chat_members WHERE chat_id=? AND user_id=?`, cid, user.id);
    }
  }
  for (const s of all(`SELECT id, attachment_id FROM stories WHERE user_id=?`, user.id)) {
    run(`DELETE FROM story_views WHERE story_id=?`, s.id);
    const a = get(`SELECT * FROM attachments WHERE id=?`, s.attachment_id);
    if (a) { removeObject(a.path); if (a.thumb_path) removeObject(a.thumb_path); }
    run(`DELETE FROM attachments WHERE id=?`, s.attachment_id);
    run(`DELETE FROM stories WHERE id=?`, s.id);
  }
  if (user.avatar_attachment_id) {
    const a = get(`SELECT * FROM attachments WHERE id=?`, user.avatar_attachment_id);
    if (a) { removeObject(a.path); if (a.thumb_path) removeObject(a.thumb_path); }
    run(`DELETE FROM attachments WHERE id=?`, user.avatar_attachment_id);
  }
  run(`DELETE FROM story_views WHERE viewer_id=?`, user.id);
  run(`DELETE FROM notifications WHERE user_id=?`, user.id);
  run(`DELETE FROM blocks WHERE blocker_id=? OR blocked_id=?`, user.id, user.id);
  run(`DELETE FROM reports WHERE reporter_id=?`, user.id);
  run(`DELETE FROM sessions WHERE user_id=?`, user.id);
  run(`DELETE FROM email_tokens WHERE user_id=?`, user.id);
  run(`DELETE FROM user_settings WHERE user_id=?`, user.id);
  run(`DELETE FROM reactions WHERE user_id=?`, user.id);
  run(`DELETE FROM message_deletions WHERE user_id=?`, user.id);
  run(`DELETE FROM users WHERE id=?`, user.id);
  kickUser(user.id, 'Account deleted by moderation');
  res.json({ message: 'User and data deleted' });
});

adminRouter.get('/reports', (req, res) => {
  const status = ['open', 'acted', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const rows = all(
    `SELECT r.*, u.display_name AS reporter_name, u.username AS reporter_username FROM reports r
     JOIN users u ON u.id=r.reporter_id
     ${status !== 'all' ? `WHERE r.status=?` : ''} ORDER BY r.id DESC LIMIT 100`,
    status !== 'all' ? [status] : []
  );
  res.json({
    reports: rows.map((r) => ({
      id: r.id, targetType: r.target_type, targetId: r.target_id, reason: r.reason, details: r.details,
      status: r.status, createdAt: r.created_at, handledBy: r.handled_by,
      reporter: { id: r.reporter_id, name: r.reporter_name, username: r.reporter_username },
      targetPreview: targetPreview(r),
    })),
  });
});

function targetPreview(r) {
  if (r.target_type === 'user') {
    const u = get(`SELECT id, display_name, username, email FROM users WHERE id=?`, r.target_id);
    return u ? { ...u, kind: 'user' } : null;
  }
  if (r.target_type === 'message') {
    const m = get(`SELECT id, chat_id, text, kind, sender_id FROM messages WHERE id=?`, r.target_id);
    return m ? { ...m, kind: 'message' } : null;
  }
  if (r.target_type === 'chat') {
    const c = get(`SELECT id, name, type, username FROM chats WHERE id=?`, r.target_id);
    return c ? { ...c, kind: 'chat' } : null;
  }
  if (r.target_type === 'story') {
    const s = get(`SELECT id, user_id, caption FROM stories WHERE id=?`, r.target_id);
    return s ? { ...s, kind: 'story' } : null;
  }
  return null;
}

adminRouter.patch('/reports/:id', (req, res) => {
  const report = get(`SELECT * FROM reports WHERE id=?`, +req.params.id);
  if (!report) return fail(res, 404, 'not_found', 'Report not found');
  const status = ['acted', 'dismissed', 'open'].includes(req.body?.status) ? req.body.status : 'dismissed';
  run(`UPDATE reports SET status=?, handled_by=? WHERE id=?`, status, req.user.id, report.id);
  if (status === 'acted' && req.body?.suspendTarget && report.target_type === 'user') {
    run(`UPDATE users SET suspended=1, suspended_reason=? WHERE id=? AND role!='admin'`, 'Suspended after moderation review', report.target_id);
    kickUser(report.target_id, 'Account suspended');
  }
  res.json({ message: 'Report updated' });
});

adminRouter.get('/chats', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = all(
    `SELECT * FROM chats WHERE type!='direct' ${q ? 'AND (name LIKE ? OR username LIKE ?)' : ''} ORDER BY id DESC LIMIT 100`,
    q ? [like, like] : []
  );
  res.json({ chats: rows.map((c) => ({ ...serializeChat(c, req.user), memberCount: get(`SELECT COUNT(*) c FROM chat_members WHERE chat_id=?`, c.id).c })) });
});

adminRouter.delete('/chats/:id', (req, res) => {
  const chat = get(`SELECT * FROM chats WHERE id=? AND type!='direct'`, +req.params.id);
  if (!chat) return fail(res, 404, 'not_found', 'Chat not found');
  run(`DELETE FROM messages WHERE chat_id=?`, chat.id);
  run(`DELETE FROM pinned_messages WHERE chat_id=?`, chat.id);
  run(`DELETE FROM invites WHERE chat_id=?`, chat.id);
  run(`DELETE FROM chat_members WHERE chat_id=?`, chat.id);
  run(`DELETE FROM chats WHERE id=?`, chat.id);
  res.json({ message: 'Chat removed by moderation' });
});

adminRouter.get('/banned-usernames', (req, res) => {
  res.json({ usernames: all(`SELECT username FROM banned_usernames ORDER BY username`).map((r) => r.username) });
});
adminRouter.post('/banned-usernames', (req, res) => {
  const u = String(req.body?.username || '').toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(u)) return fail(res, 400, 'invalid', 'Invalid username');
  run(`INSERT OR IGNORE INTO banned_usernames(username) VALUES(?)`, u);
  res.json({ message: 'Username banned' });
});
adminRouter.delete('/banned-usernames/:username', (req, res) => {
  run(`DELETE FROM banned_usernames WHERE username=?`, req.params.username.toLowerCase());
  res.json({ message: 'Username unbanned' });
});

adminRouter.get('/settings', (req, res) => {
  res.json({ limits: platformSetting('limits', {}), emailMode: get(`SELECT 1`) && process.env.EMAIL_MODE || 'dev' });
});
adminRouter.patch('/settings', (req, res) => {
  const limits = platformSetting('limits', {});
  const next = { ...limits, ...(req.body?.limits || {}) };
  next.newAccountMessageLimitPerHour = Math.max(1, Math.min(1000, +next.newAccountMessageLimitPerHour || 40));
  next.establishedMessageLimitPerMinute = Math.max(1, Math.min(500, +next.establishedMessageLimitPerMinute || 30));
  next.maxUploadMB = Math.max(1, Math.min(512, +next.maxUploadMB || 64));
  next.signupEnabled = !!next.signupEnabled;
  setPlatformSetting('limits', next);
  res.json({ limits: next });
});

adminRouter.get('/login-attempts', (req, res) => {
  res.json({ attempts: all(`SELECT username, email, ip, success, created_at FROM login_attempts ORDER BY id DESC LIMIT 100`).map((a) => ({ username: a.username || a.email, ip: a.ip, success: !!a.success, createdAt: a.created_at })) });
});

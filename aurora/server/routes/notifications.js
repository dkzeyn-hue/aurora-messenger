import express from 'express';
import { get, all, run } from '../db/index.js';
import { authenticate, requireVerifiedEmail } from '../middleware/auth.js';

export const notificationsRouter = express.Router();
notificationsRouter.use(authenticate(), requireVerifiedEmail);

notificationsRouter.get('/', (req, res) => {
  const limit = Math.min(100, +req.query.limit || 40);
  const before = req.query.before ? +req.query.before : undefined;
  const rows = all(
    `SELECT * FROM notifications WHERE user_id=? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
    before ? [req.user.id, before, limit] : [req.user.id, limit]
  );
  const withActors = rows.map((n) => {
    let actor = null;
    if (n.actor_id) {
      const u = get(`SELECT id, display_name, username, avatar_attachment_id FROM users WHERE id=?`, n.actor_id);
      if (u) actor = { id: u.id, displayName: u.display_name, username: u.username, avatar: u.avatar_attachment_id ? `/api/files/${u.avatar_attachment_id}` : null };
    }
    return {
      id: n.id, type: n.type, chatId: n.chat_id, messageId: n.message_id, storyId: n.story_id,
      title: n.title, body: n.body, read: !!n.read, createdAt: n.created_at, actor,
    };
  });
  res.json({ notifications: withActors, unread: get(`SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0`, req.user.id).c });
});

notificationsRouter.post('/:id/read', (req, res) => {
  run(`UPDATE notifications SET read=1 WHERE id=? AND user_id=?`, +req.params.id, req.user.id);
  res.json({ ok: true });
});

notificationsRouter.post('/read-all', (req, res) => {
  run(`UPDATE notifications SET read=1 WHERE user_id=?`, req.user.id);
  res.json({ ok: true });
});

notificationsRouter.delete('/:id', (req, res) => {
  run(`DELETE FROM notifications WHERE id=? AND user_id=?`, +req.params.id, req.user.id);
  res.json({ ok: true });
});

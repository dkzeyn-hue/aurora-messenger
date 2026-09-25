import express from 'express';
import { get, all } from '../db/index.js';
import { authenticate, requireVerifiedEmail, fail } from '../middleware/auth.js';
import { serializeUser, serializeChat, serializeMessage } from '../services/serialize.js';
import { canSeeProfilePhoto } from '../services/access.js';
import { searchLimiter } from '../services/ratelimit.js';

export const searchRouter = express.Router();
searchRouter.use(authenticate(), requireVerifiedEmail, searchLimiter);

/**
 * GET /api/search?q=...&scope=all|people|chats|messages|media
 * Global, permission-aware search.
 */
searchRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const scope = ['all', 'people', 'chats', 'messages', 'media'].includes(req.query.scope) ? req.query.scope : 'all';
  if (q.length < 2) return res.json({ people: [], chats: [], messages: [], media: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const out = { people: [], chats: [], messages: [], media: [] };

  if (scope === 'all' || scope === 'people') {
    const rows = all(
      `SELECT * FROM users WHERE suspended=0 AND (username LIKE ? OR display_name LIKE ?)
       ORDER BY CASE WHEN username=? THEN 0 ELSE 1 END LIMIT 20`,
      like, like, q.replace(/^@/, '').toLowerCase()
    );
    out.people = rows.map((u) => serializeUser(u, req.user));
  }

  if (scope === 'all' || scope === 'chats') {
    const mine = all(
      `SELECT c.* FROM chats c JOIN chat_members m ON m.chat_id=c.id AND m.user_id=?
       WHERE c.type IN ('group','channel') AND (c.name LIKE ? OR c.username LIKE ?) LIMIT 20`, req.user.id, like, like
    );
    const publicChats = all(
      `SELECT * FROM chats WHERE is_public=1 AND (name LIKE ? OR username LIKE ?)
       AND id NOT IN (${mine.map(() => '?').join(',') || 'NULL'}) LIMIT 10`,
      like, like, ...mine.map((c) => c.id)
    );
    out.chats = [...mine, ...publicChats].map((c) => serializeChat(c, req.user));
  }

  if (scope === 'all' || scope === 'messages' || scope === 'media') {
    const rows = all(
      `SELECT m.*, c.name AS chat_name, c.type AS chat_type FROM messages m
       JOIN chats c ON c.id=m.chat_id
       JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=? AND cm.banned=0
       LEFT JOIN message_deletions d ON d.message_id=m.id AND d.user_id=?
       WHERE d.message_id IS NULL AND m.kind!='system'
       ${scope === 'media' ? `AND m.kind IN ('image','video','document','audio','voice')` : ''}
       AND (m.text LIKE ? OR (m.kind IN ('document','audio','video','image') AND m.id IN (
            SELECT id FROM messages WHERE attachment_id IN (SELECT id FROM attachments WHERE filename LIKE ?))))
       ORDER BY m.id DESC LIMIT ${scope === 'messages' || scope === 'media' ? 60 : 20}`,
      req.user.id, req.user.id, like, like
    );
    const map = (r) => {
      const chat = get(`SELECT * FROM chats WHERE id=?`, r.chat_id);
      const s = serializeMessage(r, req.user, chat);
      s.chatName = chat?.type === 'direct' ? (chat ? undefined : undefined) : r.chat_name;
      s.chatType = r.chat_type;
      if (chat?.type === 'direct') {
        const peer = get(`SELECT display_name FROM chat_members cm JOIN users u ON u.id=cm.user_id WHERE cm.chat_id=? AND u.id!=?`, chat.id, req.user.id);
        s.chatName = peer?.display_name || 'Direct chat';
      }
      return s;
    };
    if (scope === 'media') out.media = rows.map(map);
    else out.messages = rows.map(map);
    if (scope === 'all') {
      const mediaRows = all(
        `SELECT m.* FROM messages m
         JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=? AND cm.banned=0
         LEFT JOIN message_deletions d ON d.message_id=m.id AND d.user_id=?
         WHERE d.message_id IS NULL AND m.kind IN ('image','video','document') AND m.text LIKE ?
         ORDER BY m.id DESC LIMIT 12`, req.user.id, req.user.id, like
      );
      out.media = mediaRows.map((r) => {
        const chat = get(`SELECT * FROM chats WHERE id=?`, r.chat_id);
        return serializeMessage(r, req.user, chat);
      });
    }
  }
  res.json(out);
});

// deep-link resolution: aurora://user/x, /join/code, @username, channel @name
searchRouter.get('/resolve', (req, res) => {
  const target = String(req.query.target || '').trim();
  if (!target) return fail(res, 400, 'invalid', 'Missing target');
  const name = target.replace(/^(@|aurora:\/\/(user|group|channel|c|g)\/|https?:\/\/[^/]+\/(user|c|g|join)\/)/i, '').toLowerCase();
  const user = get(`SELECT * FROM users WHERE username=? AND suspended=0`, name);
  if (user) return res.json({ type: 'user', data: serializeUser(user, req.user) });
  const chat = get(`SELECT * FROM chats WHERE username=?`, name);
  if (chat) {
    if (!chat.is_public && chat.type !== 'direct') {
      const m = get(`SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?`, chat.id, req.user.id);
      if (!m && req.user.role !== 'admin') return fail(res, 403, 'private', 'This is a private chat');
    }
    return res.json({ type: chat.type, data: serializeChat(chat, req.user) });
  }
  return fail(res, 404, 'not_found', `Nothing found for "${target}"`);
});

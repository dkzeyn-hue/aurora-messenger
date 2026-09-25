import express from 'express';
import { get, all, run } from '../db/index.js';
import { authenticate, requireVerifiedEmail, fail } from '../middleware/auth.js';
import { requireChatAccess, canModerate, canManageChat, isBlockedBetween, getSettings, membership } from '../services/access.js';
import { serializeMessage, serializeChat } from '../services/serialize.js';
import { getIO, toUsers, createNotification } from '../services/realtime.js';
import { checkMessageSpam } from '../services/spam.js';
import { messageLimiter, searchLimiter } from '../services/ratelimit.js';
import { validateUpload } from '../services/storage.js';

export const messagesRouter = express.Router();
messagesRouter.use(authenticate(), requireVerifiedEmail);

const MSG_KINDS = ['text', 'image', 'video', 'voice', 'audio', 'document', 'sticker'];

// ---- fetch (pagination) ------------------------------------------------------
messagesRouter.get('/chat/:id', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  const limit = Math.min(100, Math.max(1, +req.query.limit || 40));
  const before = req.query.before ? +req.query.before : undefined;
  const after = req.query.after ? +req.query.after : undefined;
  const parentPostId = req.query.parentPostId ? +req.query.parentPostId : undefined;

  let where = `m.chat_id=@chatId AND d.message_id IS NULL`;
  if (before) where += ` AND m.id < @before`;
  if (after) where += ` AND m.id > @after`;
  if (parentPostId !== undefined) where += ` AND m.parent_post_id=@parentPostId`;
  const order = after ? 'ASC' : 'DESC';

  const rows = all(
    `SELECT m.* FROM messages m
     LEFT JOIN message_deletions d ON d.message_id=m.id AND d.user_id=@viewer
     WHERE ${where}
     ORDER BY m.id ${order} LIMIT @limit`,
    { chatId: access.chat.id, viewer: req.user.id, before, after, parentPostId, limit }
  );
  if (order === 'DESC') rows.reverse();

  // channel view counting
  if (access.chat.type === 'channel' && !access.member) {
    run(`UPDATE messages SET views=views+1 WHERE chat_id=? AND id IN (${rows.map(() => '?').join(',') || 'NULL'})`, access.chat.id, ...rows.map((r) => r.id));
  }
  // mark delivered for members reading
  if (access.member && rows.length) {
    run(`UPDATE chat_members SET last_delivered_message_id=MAX(last_delivered_message_id,?) WHERE chat_id=? AND user_id=?`, rows[rows.length - 1].id, access.chat.id, req.user.id);
  }
  res.json({ messages: rows.map((m) => serializeMessage(m, req.user, access.chat)), hasMore: rows.length === limit });
});

// ---- send --------------------------------------------------------------------
function pushMessage(chat, msg, senderId) {
  const io = getIO();
  if (!io) return;
  io.to(`c:${chat.id}`).emit('message:new', { message: msg });
  const members = all(`SELECT user_id, notifications_enabled, muted_until FROM chat_members WHERE chat_id=? AND user_id!=? AND banned=0`, chat.id, senderId);
  const recipients = members.filter((m) => m.user_id !== senderId).map((m) => m.user_id);

  // notifications
  const mentionMatches = [...(msg.text || '').matchAll(/@([a-z0-9_]{3,32})/gi)].map((m) => m[1].toLowerCase());
  const mentioned = mentionMatches.length
    ? all(`SELECT id FROM users WHERE username IN (${mentionMatches.map(() => '?').join(',')})`, ...mentionMatches).map((u) => u.id)
    : [];
  const previewText = msg.text || attachmentPreview(msg.kind);
  for (const m of members) {
    if (m.user_id === senderId) continue;
    let blocked = false;
    if (chat.type === 'direct') blocked = isBlockedBetween(senderId, m.user_id);
    const settings = getSettings(m.user_id);
    const wantsDesktop = settings.notifications.desktop !== false && m.notifications_enabled;
    const isMention = mentioned.includes(m.user_id);
    const isReplyToMe = msg.replyToId && (() => {
      const orig = get(`SELECT sender_id FROM messages WHERE id=?`, msg.replyToId);
      return orig?.sender_id === m.user_id;
    })();
    if (blocked) continue;
    if (chat.type === 'direct' || isMention || isReplyToMe || wantsDesktop) {
      const type = isMention ? 'mention' : isReplyToMe ? 'reply' : chat.type === 'channel' ? 'channel_post' : 'message';
      createNotification(m.user_id, {
        type, chatId: chat.id, messageId: msg.id, actorId: senderId,
        title: chat.type === 'direct' ? (msg.senderName || 'New message') : `${msg.senderName || 'Post'} in ${chat.name}`,
        body: previewText.slice(0, 140),
      });
    }
  }
  return recipients;
}

function attachmentPreview(kind) {
  return { image: '📷 Photo', video: '🎬 Video', voice: '🎙 Voice message', audio: '🎵 Audio', document: '📎 File', sticker: 'Sticker' }[kind] || 'Message';
}

messagesRouter.post('/chat/:id', messageLimiter, (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  const { chat, member } = access;

  // --- permission gauntlet ---
  if (chat.type === 'direct') {
    if (!member) return fail(res, 403, 'forbidden', 'Chat not available');
    const peer = get(`SELECT user_id FROM chat_members WHERE chat_id=? AND user_id!=?`, chat.id, req.user.id)?.user_id;
    if (peer && isBlockedBetween(req.user.id, peer)) {
      const iBlocked = !!get(`SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?`, req.user.id, peer);
      if (iBlocked) return fail(res, 403, 'blocked_by_you', 'Unblock this user to send messages');
      // they blocked me: accept silently (Telegram-style), skip delivery below
    }
  } else {
    if (!member && !(chat.type === 'channel' && chat.is_public && req.body?.parentPostId))
      return fail(res, 403, 'forbidden', 'Join this chat to send messages');
    if (member?.banned) return fail(res, 403, 'banned', 'You are banned in this chat');
    if (member?.muted_until && member.muted_until > new Date().toISOString().replace('T', ' ').slice(0, 19))
      return fail(res, 403, 'muted', `You are muted in this chat until ${member.muted_until} UTC`);
    const settings = JSON.parse(chat.settings || '{}');
    if (chat.type === 'channel' && !req.body?.parentPostId && !canManageChat(req.user, chat, member))
      return fail(res, 403, 'admins_only', 'Only admins can post in this channel');
    if (chat.type === 'channel' && req.body?.parentPostId && settings.commentsEnabled === false)
      return fail(res, 403, 'comments_disabled', 'Comments are disabled for this channel');
    if (settings.slowMode > 0 && member && member.role === 'member') {
      const lastOwn = get(`SELECT created_at FROM messages WHERE chat_id=? AND sender_id=? AND kind!='system' ORDER BY id DESC LIMIT 1`, chat.id, req.user.id);
      if (lastOwn) {
        const elapsed = (Date.now() - new Date(lastOwn.created_at.replace(' ', 'T') + 'Z').getTime()) / 1000;
        if (elapsed < settings.slowMode)
          return fail(res, 429, 'slow_mode', `Slow mode is on. Wait ${Math.ceil(settings.slowMode - elapsed)}s before sending again.`);
      }
    }
  }

  const kind = MSG_KINDS.includes(req.body?.kind) ? req.body.kind : 'text';
  let text = String(req.body?.text || '');
  if (kind === 'text' && !text.trim() && !req.body?.attachmentId) return fail(res, 400, 'empty', 'Message is empty');
  if (text.length > 8000) return fail(res, 400, 'too_long', 'Message text is limited to 8000 characters');

  let attachment = null;
  if (req.body?.attachmentId) {
    attachment = get(`SELECT * FROM attachments WHERE id=? AND owner_id=?`, +req.body.attachmentId, req.user.id);
    if (!attachment) return fail(res, 400, 'invalid_attachment', 'Attachment not found — please re-upload');
    const v = validateUpload(attachment.kind === 'avatar' ? 'image' : attachment.kind, attachment.mime, attachment.size / 1048576);
    if (!v.ok) return fail(res, 400, 'invalid_file', v.error);
  }
  const spam = checkMessageSpam(req.user, chat.id, text);
  if (spam.blocked) return fail(res, 429, 'spam_blocked', spam.reason);

  let replyToId = null;
  if (req.body?.replyToId) {
    const r = get(`SELECT id FROM messages WHERE id=? AND chat_id=?`, +req.body.replyToId, chat.id);
    if (r) replyToId = r.id;
  }
  let fwdFrom = null;
  if (req.body?.fwdFrom) fwdFrom = JSON.stringify(req.body.fwdFrom).slice(0, 500);
  const parentPostId = req.body?.parentPostId ? +req.body.parentPostId : null;
  if (parentPostId && !get(`SELECT 1 FROM messages WHERE id=? AND chat_id=?`, parentPostId, chat.id))
    return fail(res, 400, 'invalid_parent', 'Parent post not found');
  const anonymous = chat.type === 'channel' && !parentPostId && req.body?.anonymous !== false ? 1 : 0;

  const info = run(
    `INSERT INTO messages(chat_id,sender_id,anonymous,kind,text,attachment_id,reply_to_id,fwd_from,parent_post_id)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    chat.id, req.user.id, anonymous, kind, text, attachment?.id || null, replyToId, fwdFrom, parentPostId
  );
  const msgRow = get(`SELECT * FROM messages WHERE id=?`, info.lastInsertRowid);
  const msg = serializeMessage(msgRow, req.user, chat);
  msg.senderName = anonymous ? chat.name : req.user.display_name;

  // un-archive DMs on new message; push realtime
  run(`UPDATE chat_members SET archived=0 WHERE chat_id=?`, chat.id);
  const peerBlockedMe = chat.type === 'direct' && (() => {
    const peer = get(`SELECT user_id FROM chat_members WHERE chat_id=? AND user_id!=?`, chat.id, req.user.id)?.user_id;
    return peer && !!get(`SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?`, peer, req.user.id);
  })();
  if (!peerBlockedMe) pushMessage(chat, msg, req.user.id);
  else getIO()?.to(`u:${req.user.id}`).emit('message:new:self', { message: msg });

  res.status(201).json({ message: msg });
});

// ---- forward to multiple chats -------------------------------------------------
messagesRouter.post('/:messageId/forward', messageLimiter, (req, res) => {
  const src = get(`SELECT * FROM messages WHERE id=?`, +req.params.messageId);
  if (!src) return fail(res, 404, 'not_found', 'Message not found');
  const srcAccess = requireChatAccess(req.user, src.chat_id);
  if (srcAccess.error) return fail(res, 403, 'forbidden', 'No access to the original message');
  if (get(`SELECT 1 FROM message_deletions WHERE message_id=? AND user_id=?`, src.id, req.user.id)) return fail(res, 404, 'not_found', 'Message not found');

  // forward protection privacy
  if (src.sender_id && src.sender_id !== req.user.id) {
    const senderSettings = getSettings(src.sender_id);
    if (senderSettings.privacy.forwardProtection && srcAccess.chat.type === 'direct')
      return fail(res, 403, 'forward_protected', 'This user has disabled forwarding of their messages');
  }

  const chatIds = (req.body?.chatIds || []).map(Number).filter(Boolean).slice(0, 20);
  const forwarded = [];
  const srcChat = srcAccess.chat;
  const fwdMeta = {
    name: src.anonymous ? srcChat.name : (get(`SELECT display_name FROM users WHERE id=?`, src.sender_id)?.display_name || 'Unknown'),
    chatId: srcChat.type === 'direct' ? undefined : srcChat.id,
    messageId: src.id,
    username: srcChat.username || undefined,
  };
  for (const cid of chatIds) {
    const access = requireChatAccess(req.user, cid);
    if (access.error) continue;
    if (access.chat.type === 'channel' && !canManageChat(req.user, access.chat, access.member)) continue;
    const m = access.member;
    if (access.chat.type !== 'direct' && access.chat.type !== 'channel' && (!m || m.banned || (m.muted_until && m.muted_until > new Date().toISOString().replace('T', ' ').slice(0, 19)))) continue;
    const info = run(
      `INSERT INTO messages(chat_id,sender_id,kind,text,attachment_id,reply_to_id,fwd_from) VALUES(?,?,?,?,?,?,?)`,
      cid, req.user.id, src.kind, src.text, src.attachment_id, null, JSON.stringify(fwdMeta)
    );
    const row = get(`SELECT * FROM messages WHERE id=?`, info.lastInsertRowid);
    const msg = serializeMessage(row, req.user, access.chat);
    msg.senderName = req.user.display_name;
    run(`UPDATE chat_members SET archived=0 WHERE chat_id=?`, cid);
    pushMessage(access.chat, msg, req.user.id);
    forwarded.push(msg);
  }
  if (!forwarded.length) return fail(res, 403, 'no_targets', 'Could not forward to any of the selected chats');
  res.status(201).json({ messages: forwarded });
});

// ---- edit ------------------------------------------------------------------------
messagesRouter.patch('/:id', (req, res) => {
  const msg = get(`SELECT * FROM messages WHERE id=?`, +req.params.id);
  if (!msg) return fail(res, 404, 'not_found', 'Message not found');
  const access = requireChatAccess(req.user, msg.chat_id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (msg.sender_id !== req.user.id) return fail(res, 403, 'forbidden', 'You can only edit your own messages');
  if (msg.kind === 'system') return fail(res, 400, 'invalid', 'System messages cannot be edited');
  const text = String(req.body?.text ?? '');
  if (!text.trim() && !msg.attachment_id) return fail(res, 400, 'empty', 'Message cannot be empty');
  if (text.length > 8000) return fail(res, 400, 'too_long', 'Message too long');
  run(`UPDATE messages SET text=?, edited_at=datetime('now') WHERE id=?`, text, msg.id);
  const fresh = serializeMessage(get(`SELECT * FROM messages WHERE id=?`, msg.id), req.user, access.chat);
  getIO()?.to(`c:${msg.chat_id}`).emit('message:edited', { message: fresh });
  res.json({ message: fresh });
});

// ---- delete --------------------------------------------------------------------------
messagesRouter.delete('/:id', (req, res) => {
  const msg = get(`SELECT * FROM messages WHERE id=?`, +req.params.id);
  if (!msg) return fail(res, 404, 'not_found', 'Message not found');
  const access = requireChatAccess(req.user, msg.chat_id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  const scope = req.query.scope === 'all' ? 'all' : 'me';

  if (scope === 'me') {
    run(`INSERT OR IGNORE INTO message_deletions(message_id,user_id) VALUES(?,?)`, msg.id, req.user.id);
    run(`DELETE FROM pinned_messages WHERE message_id=? AND chat_id=?`, msg.id, msg.chat_id);
    return res.json({ message: 'Deleted for you' });
  }
  // delete for everyone
  const isOwn = msg.sender_id === req.user.id;
  const canModerateHere = canModerate(req.user, access.chat, access.member);
  const withinWindow = (Date.now() - new Date(msg.created_at.replace(' ', 'T') + 'Z').getTime()) < 48 * 3600 * 1000;
  if (!isOwn && !canModerateHere) return fail(res, 403, 'forbidden', 'You can only delete your own messages');
  if (isOwn && !canModerateHere && access.chat.type === 'channel' && msg.anonymous && !withinWindow)
    return fail(res, 403, 'too_old', 'Channel posts can only be deleted within 48 hours');

  run(`DELETE FROM reactions WHERE message_id=?`, msg.id);
  run(`DELETE FROM pinned_messages WHERE message_id=?`, msg.id);
  run(`DELETE FROM message_deletions WHERE message_id=?`, msg.id);
  run(`DELETE FROM messages WHERE id=?`, msg.id);
  getIO()?.to(`c:${msg.chat_id}`).emit('message:deleted', { chatId: msg.chat_id, messageId: msg.id });
  res.json({ message: 'Deleted for everyone' });
});

// ---- react -------------------------------------------------------------------------------
const DEFAULT_REACTIONS = ['👍', '❤️', '🔥', '🎉', '😂', '😮', '😢', '🙏'];
messagesRouter.post('/:id/react', (req, res) => {
  const msg = get(`SELECT * FROM messages WHERE id=?`, +req.params.id);
  if (!msg) return fail(res, 404, 'not_found', 'Message not found');
  const access = requireChatAccess(req.user, msg.chat_id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (access.chat.type !== 'direct' && access.chat.type !== 'channel' && !access.member) return fail(res, 403, 'forbidden', 'Join to react');
  const emoji = String(req.body?.emoji || '');
  if (!emoji) return fail(res, 400, 'invalid', 'Choose a reaction');
  const allowed = JSON.parse(access.chat.settings || '{}').allowedReactions || DEFAULT_REACTIONS;
  if (emoji !== 'none' && !allowed.includes(emoji)) return fail(res, 400, 'invalid_emoji', 'Reaction not allowed in this chat');

  if (emoji === 'none') run(`DELETE FROM reactions WHERE message_id=? AND user_id=?`, msg.id, req.user.id);
  else run(
    `INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji, created_at=datetime('now')`,
    msg.id, req.user.id, emoji
  );
  const fresh = serializeMessage(msg, req.user, access.chat);
  getIO()?.to(`c:${msg.chat_id}`).emit('message:reaction', { message: fresh });
  if (msg.sender_id && msg.sender_id !== req.user.id && emoji !== 'none') {
    createNotification(msg.sender_id, {
      type: 'reaction', chatId: msg.chat_id, messageId: msg.id, actorId: req.user.id,
      title: `${req.user.display_name} reacted ${emoji}`, body: (msg.text || attachmentPreview(msg.kind)).slice(0, 100),
    });
  }
  res.json({ message: fresh });
});

// ---- search -------------------------------------------------------------------------------
messagesRouter.get('/search/global', searchLimiter, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = all(
    `SELECT m.*, c.type AS chat_type, c.name AS chat_name FROM messages m
     JOIN chats c ON c.id=m.chat_id
     JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=? AND cm.banned=0
     LEFT JOIN message_deletions d ON d.message_id=m.id AND d.user_id=?
     WHERE d.message_id IS NULL AND m.text LIKE ? AND m.kind!='system'
     ORDER BY m.id DESC LIMIT 50`, req.user.id, req.user.id, like
  );
  // public channels the user hasn't joined
  const pub = all(
    `SELECT m.*, c.type AS chat_type, c.name AS chat_name FROM messages m JOIN chats c ON c.id=m.chat_id
     WHERE c.is_public=1 AND c.type='channel' AND m.text LIKE ? AND m.kind!='system'
     AND NOT EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id=c.id AND cm.user_id=?)
     ORDER BY m.id DESC LIMIT 20`, like, req.user.id
  );
  const mapRow = (r) => {
    const chat = get(`SELECT * FROM chats WHERE id=?`, r.chat_id);
    return { ...serializeMessage(r, req.user, chat), chatType: r.chat_type, chatName: chat?.type === 'direct' ? undefined : r.chat_name };
  };
  res.json({ results: [...rows, ...pub].map(mapRow) });
});

messagesRouter.get('/search/chat/:id', searchLimiter, (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const rows = all(
    `SELECT m.* FROM messages m LEFT JOIN message_deletions d ON d.message_id=m.id AND d.user_id=?
     WHERE m.chat_id=? AND d.message_id IS NULL AND m.text LIKE ? ORDER BY m.id DESC LIMIT 100`,
    req.user.id, access.chat.id, `%${q.replace(/[%_]/g, '')}%`
  );
  res.json({ results: rows.map((m) => serializeMessage(m, req.user, access.chat)) });
});

// saved messages ("Saved" = self-bookmarks) -----------------------------------------------
messagesRouter.post('/:id/save', (req, res) => {
  const msg = get(`SELECT * FROM messages WHERE id=?`, +req.params.id);
  if (!msg) return fail(res, 404, 'not_found', 'Message not found');
  const access = requireChatAccess(req.user, msg.chat_id);
  if (access.error) return fail(res, 403, 'forbidden', 'No access');
  // forward into the user's Saved chat (a direct chat with themselves)
  let saved = get(
    `SELECT c.id FROM chats c JOIN chat_members m1 ON m1.chat_id=c.id JOIN chat_members m2 ON m2.chat_id=c.id
     WHERE c.type='direct' AND m1.user_id=? AND m2.user_id=? AND c.owner_id=?`, req.user.id, req.user.id, req.user.id
  );
  let savedId = saved?.id;
  if (!savedId) {
    const i = run(`INSERT INTO chats(type,name,owner_id) VALUES('direct','Saved Messages',?)`, req.user.id);
    savedId = i.lastInsertRowid;
    run(`INSERT INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'owner')`, savedId, req.user.id);
  }
  const fwdMeta = { name: msg.anonymous ? access.chat.name : (get(`SELECT display_name FROM users WHERE id=?`, msg.sender_id)?.display_name || 'Unknown'), chatId: access.chat.type === 'direct' ? undefined : msg.chat_id, messageId: msg.id };
  const info = run(
    `INSERT INTO messages(chat_id,sender_id,kind,text,attachment_id,fwd_from) VALUES(?,?,?,?,?,?)`,
    savedId, req.user.id, msg.kind, msg.text, msg.attachment_id, JSON.stringify(fwdMeta)
  );
  res.status(201).json({ message: serializeMessage(get(`SELECT * FROM messages WHERE id=?`, info.lastInsertRowid), req.user), chatId: savedId });
});

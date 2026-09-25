import express from 'express';
import crypto from 'node:crypto';
import { get, all, run, tx } from '../db/index.js';
import { authenticate, requireVerifiedEmail, fail } from '../middleware/auth.js';
import { requireChatAccess, canManageChat, canModerate, membership, canAddToGroup, canDirectMessage, isBlockedBetween, getSettings } from '../services/access.js';
import { serializeChat, serializeUser, serializeMessage } from '../services/serialize.js';
import { toChatMembers, toUser, toUsers, createNotification, contactsOf } from '../services/realtime.js';
import { searchLimiter } from '../services/ratelimit.js';

export const chatsRouter = express.Router();
chatsRouter.use(authenticate(), requireVerifiedEmail);

// ---- list ------------------------------------------------------------------
chatsRouter.get('/', (req, res) => {
  const archived = req.query.archived === '1' ? 1 : 0;
  const rows = all(
    `SELECT c.*, m.role, m.last_read_message_id, m.notifications_enabled, m.archived, m.pinned_order, m.muted_until, m.banned
     FROM chat_members m JOIN chats c ON c.id=m.chat_id
     WHERE m.user_id=? AND m.archived=? AND m.banned=0
     ORDER BY m.pinned_order IS NULL, m.pinned_order DESC, c.id DESC`,
    req.user.id, archived
  );
  const chats = rows.map((c) => serializeChat(c, req.user, c)).filter((c) => c.type !== 'direct' || c.peer);
  // order by last activity
  chats.sort((a, b) => {
    if ((b.pinnedOrder ?? -1) !== (a.pinnedOrder ?? -1)) return (b.pinnedOrder ?? -1) - (a.pinnedOrder ?? -1);
    return (b.lastMessage?.id || 0) - (a.lastMessage?.id || 0);
  });
  res.json({ chats });
});

// ---- direct chat -----------------------------------------------------------
chatsRouter.post('/direct', (req, res) => {
  const { userId, username } = req.body || {};
  let target = null;
  if (userId) target = get(`SELECT * FROM users WHERE id=? AND suspended=0`, +userId);
  else if (username) target = get(`SELECT * FROM users WHERE username=? AND suspended=0`, String(username).replace(/^@/, '').toLowerCase());
  if (!target) return fail(res, 404, 'user_not_found', 'User not found');
  if (target.id === req.user.id) return fail(res, 400, 'self_chat', 'You cannot chat with yourself');

  const existing = get(
    `SELECT c.id FROM chats c JOIN chat_members m1 ON m1.chat_id=c.id JOIN chat_members m2 ON m2.chat_id=c.id
     WHERE c.type='direct' AND m1.user_id=? AND m2.user_id=?`, req.user.id, target.id);
  if (existing) {
    run(`UPDATE chat_members SET archived=0 WHERE chat_id=? AND user_id=?`, existing.id, req.user.id);
    const chat = serializeChat(get(`SELECT * FROM chats WHERE id=?`, existing.id), req.user);
    return res.json({ chat });
  }
  const access = canDirectMessage(req.user, target.id);
  if (!access.ok) return fail(res, 403, 'dm_denied', access.message);

  const info = tx(() => {
    const i = run(`INSERT INTO chats(type,name,owner_id) VALUES('direct','',?)`, req.user.id);
    run(`INSERT INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'owner')`, i.lastInsertRowid, req.user.id);
    run(`INSERT INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'member')`, i.lastInsertRowid, target.id);
    return i.lastInsertRowid;
  })();
  const chat = serializeChat(get(`SELECT * FROM chats WHERE id=?`, info), req.user);
  toUser(target.id, 'chat:new', serializeChat(get(`SELECT * FROM chats WHERE id=?`, info), target));
  res.status(201).json({ chat });
});

// ---- create group / channel ------------------------------------------------
function createChat(req, res, type) {
  const { name, about, avatarAttachmentId, memberIds, isPublic, username, settings } = req.body || {};
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 64) return fail(res, 400, 'invalid_name', `${type === 'group' ? 'Group' : 'Channel'} name must be 2–64 characters`);
  if (String(about || '').length > 500) return fail(res, 400, 'about_too_long', 'Description must be under 500 characters');

  let uname = null;
  if (isPublic) {
    uname = String(username || '').toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{3,32}$/.test(uname)) return fail(res, 400, 'invalid_username', 'Public link must be 3–32 characters: letters, numbers, underscore');
    if (get(`SELECT 1 FROM banned_usernames WHERE username=?`, uname) || get(`SELECT 1 FROM chats WHERE username=?`, uname))
      return fail(res, 409, 'username_taken', 'This link name is taken or reserved');
  }
  if (avatarAttachmentId && !get(`SELECT 1 FROM attachments WHERE id=? AND owner_id=?`, avatarAttachmentId, req.user.id))
    return fail(res, 400, 'invalid_avatar', 'Invalid avatar');

  const chatId = tx(() => {
    const defSettings = type === 'channel'
      ? { commentsEnabled: true, slowMode: 0, allowedReactions: ['👍', '❤️', '🔥', '🎉', '😂', '😮', '😢', '🙏'] }
      : { slowMode: 0, allowedReactions: ['👍', '❤️', '🔥', '🎉', '😂', '😮', '😢', '🙏'] };
    const i = run(
      `INSERT INTO chats(type,name,about,avatar_attachment_id,owner_id,username,is_public,settings) VALUES(?,?,?,?,?,?,?,?)`,
      type, n, String(about || ''), avatarAttachmentId || null, req.user.id, uname, isPublic ? 1 : 0,
      JSON.stringify({ ...defSettings, ...(settings || {}) })
    );
    const cid = i.lastInsertRowid;
    run(`INSERT INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'owner')`, cid, req.user.id);
    const added = [];
    for (const mid of (memberIds || []).slice(0, 200)) {
      if (+mid === req.user.id) continue;
      if (!get(`SELECT 1 FROM users WHERE id=? AND suspended=0`, +mid)) continue;
      if (type === 'group' && !canAddToGroup(req.user, +mid)) continue;
      if (isBlockedBetween(req.user.id, +mid)) continue;
      run(`INSERT OR IGNORE INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'member')`, cid, +mid);
      added.push(+mid);
    }
    run(
      `INSERT INTO messages(chat_id,sender_id,kind,system_kind,text) VALUES(?,NULL,'system','chat_created',?)`,
      cid, `${req.user.display_name} created the ${type} "${n}"`
    );
    return { cid, added };
  })();

  const chat = get(`SELECT * FROM chats WHERE id=?`, chatId.cid);
  for (const uid of chatId.added) {
    toUser(uid, 'chat:new', serializeChat(chat, get(`SELECT * FROM users WHERE id=?`, uid)));
    createNotification(uid, {
      type: 'group_invite', chatId: chatId.cid, actorId: req.user.id,
      title: `Added to ${type}`, body: `${req.user.display_name} added you to "${n}"`,
    });
  }
  res.status(201).json({ chat: serializeChat(chat, req.user) });
}
chatsRouter.post('/group', (req, res) => createChat(req, res, 'group'));
chatsRouter.post('/channel', (req, res) => createChat(req, res, 'channel'));

// ---- read / update / delete ------------------------------------------------
chatsRouter.get('/:id', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  res.json({ chat: serializeChat(access.chat, req.user, access.member) });
});

chatsRouter.patch('/:id', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (!canManageChat(req.user, access.chat, access.member)) return fail(res, 403, 'forbidden', 'Only admins can change these settings');
  const { name, about, avatarAttachmentId, isPublic, username, settings } = req.body || {};
  if (name !== undefined) {
    const n = String(name).trim();
    if (n.length < 2 || n.length > 64) return fail(res, 400, 'invalid_name', 'Name must be 2–64 characters');
    run(`UPDATE chats SET name=? WHERE id=?`, n, access.chat.id);
  }
  if (about !== undefined) run(`UPDATE chats SET about=? WHERE id=?`, String(about).slice(0, 500), access.chat.id);
  if (avatarAttachmentId !== undefined) {
    if (avatarAttachmentId && !get(`SELECT 1 FROM attachments WHERE id=? AND owner_id=?`, avatarAttachmentId, req.user.id))
      return fail(res, 400, 'invalid_avatar', 'Invalid avatar');
    run(`UPDATE chats SET avatar_attachment_id=? WHERE id=?`, avatarAttachmentId || null, access.chat.id);
  }
  if (access.chat.type !== 'direct' && isPublic !== undefined) {
    let uname = null;
    if (isPublic) {
      uname = String(username || access.chat.username || '').toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{3,32}$/.test(uname)) return fail(res, 400, 'invalid_username', 'Invalid public link name');
      const clash = get(`SELECT id FROM chats WHERE username=? AND id!=?`, uname, access.chat.id);
      if (clash || get(`SELECT 1 FROM banned_usernames WHERE username=?`, uname)) return fail(res, 409, 'username_taken', 'Link name taken or reserved');
    }
    run(`UPDATE chats SET is_public=?, username=? WHERE id=?`, isPublic ? 1 : 0, uname, access.chat.id);
  }
  if (settings) {
    const cur = JSON.parse(access.chat.settings || '{}');
    const next = { ...cur, ...settings };
    next.slowMode = Math.max(0, Math.min(300, +next.slowMode || 0));
    run(`UPDATE chats SET settings=? WHERE id=?`, JSON.stringify(next), access.chat.id);
  }
  const fresh = serializeChat(get(`SELECT * FROM chats WHERE id=?`, access.chat.id), req.user);
  toChatMembers(access.chat.id, 'chat:updated', fresh);
  res.json({ chat: fresh });
});

chatsRouter.delete('/:id', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  const isOwner = access.chat.owner_id === req.user.id || req.user.role === 'admin';
  if (!isOwner) return fail(res, 403, 'forbidden', 'Only the owner can delete this chat');
  if (access.chat.type === 'direct') return fail(res, 400, 'use_leave', 'Use "Delete for me" / leave instead');
  tx(() => {
    run(`DELETE FROM messages WHERE chat_id=?`, access.chat.id);
    run(`DELETE FROM pinned_messages WHERE chat_id=?`, access.chat.id);
    run(`DELETE FROM invites WHERE chat_id=?`, access.chat.id);
    run(`DELETE FROM chat_members WHERE chat_id=?`, access.chat.id);
    run(`DELETE FROM chats WHERE id=?`, access.chat.id);
  })();
  toChatMembers(access.chat.id, 'chat:deleted', { chatId: access.chat.id });
  res.json({ message: 'Chat deleted' });
});

chatsRouter.post('/:id/leave', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (!access.member) return fail(res, 400, 'not_member', 'You are not a member');
  if (access.chat.type === 'direct') {
    run(`UPDATE chat_members SET archived=1 WHERE chat_id=? AND user_id=?`, access.chat.id, req.user.id);
    return res.json({ message: 'Chat hidden. It returns if either of you sends a new message.' });
  }
  if (access.member.role === 'owner' && get(`SELECT COUNT(*) c FROM chat_members WHERE chat_id=?`, access.chat.id).c > 1) {
    // transfer ownership to the most senior admin/member
    const next = get(
      `SELECT user_id FROM chat_members WHERE chat_id=? AND user_id!=? ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, joined_at LIMIT 1`,
      access.chat.id, req.user.id);
    if (next) run(`UPDATE chat_members SET role='owner' WHERE chat_id=? AND user_id=?`, access.chat.id, next.user_id);
    run(`UPDATE chats SET owner_id=? WHERE id=?`, next?.user_id || req.user.id, access.chat.id);
  }
  run(`DELETE FROM chat_members WHERE chat_id=? AND user_id=?`, access.chat.id, req.user.id);
  run(`INSERT INTO messages(chat_id,kind,system_kind,text) VALUES(?,'system','member_left',?)`, access.chat.id, `${req.user.display_name} left`);
  toChatMembers(access.chat.id, 'chat:member_left', { chatId: access.chat.id, userId: req.user.id, name: req.user.display_name });
  res.json({ message: `Left ${access.chat.type}` });
});

// ---- members ----------------------------------------------------------------
chatsRouter.get('/:id/members', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  const limit = Math.min(200, +req.query.limit || 100);
  const offset = +req.query.offset || 0;
  const rows = all(
    `SELECT u.*, m.role, m.joined_at, m.muted_until, m.banned FROM chat_members m JOIN users u ON u.id=m.user_id
     WHERE m.chat_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, m.joined_at LIMIT ? OFFSET ?`,
    access.chat.id, limit, offset
  );
  res.json({
    members: rows.map((u) => ({ ...serializeUser(u, req.user), role: u.role, joinedAt: u.joined_at, mutedUntil: u.muted_until, banned: !!u.banned })),
    total: get(`SELECT COUNT(*) c FROM chat_members WHERE chat_id=?`, access.chat.id).c,
  });
});

chatsRouter.post('/:id/members', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (access.chat.type === 'direct') return fail(res, 400, 'invalid', 'Cannot add members to a direct chat');
  const settings = JSON.parse(access.chat.settings || '{}');
  const memberCanInvite = settings.memberCanInvite !== false;
  if (!memberCanInvite && !canModerate(req.user, access.chat, access.member))
    return fail(res, 403, 'forbidden', 'Only admins can add members to this chat');
  const ids = (req.body?.userIds || []).map(Number).filter(Boolean).slice(0, 100);
  const added = [];
  for (const uid of ids) {
    if (uid === req.user.id) continue;
    if (!get(`SELECT 1 FROM users WHERE id=? AND suspended=0`, uid)) continue;
    const existing = get(`SELECT * FROM chat_members WHERE chat_id=? AND user_id=?`, access.chat.id, uid);
    if (existing?.banned) continue;
    if (existing) { run(`UPDATE chat_members SET archived=0 WHERE chat_id=? AND user_id=?`, access.chat.id, uid); added.push(uid); continue; }
    if (access.chat.type === 'group' && !canAddToGroup(req.user, uid)) continue;
    if (isBlockedBetween(req.user.id, uid)) continue;
    run(`INSERT OR IGNORE INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'member')`, access.chat.id, uid);
    run(`INSERT INTO messages(chat_id,kind,system_kind,text) VALUES(?,'system','member_joined',?)`, access.chat.id, `${req.user.display_name} added a member`);
    added.push(uid);
    createNotification(uid, { type: 'group_invite', chatId: access.chat.id, actorId: req.user.id, title: `Added to ${access.chat.type}`, body: `${req.user.display_name} added you to "${access.chat.name}"` });
  }
  getIOSafe().to(`c:${access.chat.id}`).emit('chat:members_added', { chatId: access.chat.id, userIds: added });
  for (const uid of added) toUser(uid, 'chat:new', serializeChat(access.chat, get(`SELECT * FROM users WHERE id=?`, uid)));
  res.json({ added });
});

import { getIO } from '../services/realtime.js';
const getIOSafe = () => getIO() || { to: () => ({ emit: () => {} }) };

chatsRouter.delete('/:id/members/:uid', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (!canModerate(req.user, access.chat, access.member)) return fail(res, 403, 'forbidden', 'Only admins/moderators can remove members');
  const target = get(`SELECT * FROM chat_members WHERE chat_id=? AND user_id=?`, access.chat.id, +req.params.uid);
  if (!target) return fail(res, 404, 'not_found', 'Member not found');
  const rank = { member: 0, moderator: 1, admin: 2, owner: 3 };
  if (rank[target.role] >= rank[access.member?.role || 'member'] && req.user.role !== 'admin')
    return fail(res, 403, 'forbidden', 'You cannot remove a member with equal or higher rank');
  if (req.body?.ban) {
    run(`UPDATE chat_members SET banned=1 WHERE chat_id=? AND user_id=?`, access.chat.id, target.user_id);
  } else {
    run(`DELETE FROM chat_members WHERE chat_id=? AND user_id=?`, access.chat.id, target.user_id);
  }
  run(`INSERT INTO messages(chat_id,kind,system_kind,text) VALUES(?,'system','member_removed',?)`, access.chat.id, `A member was removed by an admin`);
  toUser(target.user_id, 'chat:removed', { chatId: access.chat.id, banned: !!req.body?.ban });
  getIOSafe().to(`c:${access.chat.id}`).emit('chat:member_removed', { chatId: access.chat.id, userId: target.user_id });
  res.json({ message: 'Member removed' });
});

chatsRouter.patch('/:id/members/:uid', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (!canManageChat(req.user, access.chat, access.member)) return fail(res, 403, 'forbidden', 'Only admins can manage roles');
  const uid = +req.params.uid;
  const target = get(`SELECT * FROM chat_members WHERE chat_id=? AND user_id=?`, access.chat.id, uid);
  if (!target) return fail(res, 404, 'not_found', 'Member not found');
  const { role, mutedMinutes, unmute, unban } = req.body || {};
  if (role) {
    if (!['member', 'moderator', 'admin'].includes(role)) return fail(res, 400, 'invalid_role', 'Invalid role');
    if (target.role === 'owner') return fail(res, 403, 'forbidden', 'The owner cannot be demoted');
    if (access.member?.role !== 'owner' && req.user.role !== 'admin' && role === 'admin') return fail(res, 403, 'forbidden', 'Only the owner can promote admins');
    run(`UPDATE chat_members SET role=? WHERE chat_id=? AND user_id=?`, role, access.chat.id, uid);
  }
  if (unban) run(`UPDATE chat_members SET banned=0 WHERE chat_id=? AND user_id=?`, access.chat.id, uid);
  if (unmute) run(`UPDATE chat_members SET muted_until=NULL WHERE chat_id=? AND user_id=?`, access.chat.id, uid);
  if (mutedMinutes) {
    const until = new Date(Date.now() + Math.min(43200, +mutedMinutes) * 60000).toISOString().replace('T', ' ').slice(0, 19);
    run(`UPDATE chat_members SET muted_until=? WHERE chat_id=? AND user_id=?`, until, access.chat.id, uid);
  }
  getIOSafe().to(`c:${access.chat.id}`).emit('chat:member_updated', { chatId: access.chat.id, userId: uid, role, mutedUntil: mutedMinutes ? 'set' : unban || unmute ? null : undefined });
  res.json({ message: 'Member updated' });
});

// ---- invites ------------------------------------------------------------------
chatsRouter.post('/:id/invites', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (access.chat.type === 'direct') return fail(res, 400, 'invalid', 'Direct chats have no invite links');
  if (!canModerate(req.user, access.chat, access.member)) return fail(res, 403, 'forbidden', 'Only admins can create invite links');
  const code = crypto.randomBytes(9).toString('base64url');
  run(`INSERT INTO invites(code,chat_id,created_by,max_uses,expires_at) VALUES(?,?,?,?,?)`,
    code, access.chat.id, req.user.id, req.body?.maxUses || null, req.body?.expiresAt || null);
  res.status(201).json({ code, link: `/join/${code}` });
});

chatsRouter.get('/:id/invites', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (!canModerate(req.user, access.chat, access.member)) return fail(res, 403, 'forbidden', 'Admins only');
  res.json({ invites: all(`SELECT code, uses, max_uses, expires_at, created_at FROM invites WHERE chat_id=? ORDER BY created_at DESC`, access.chat.id).map((i) => ({ code: i.code, uses: i.uses, maxUses: i.max_uses, expiresAt: i.expires_at, createdAt: i.created_at })) });
});

chatsRouter.delete('/:id/invites/:code', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (!canModerate(req.user, access.chat, access.member)) return fail(res, 403, 'forbidden', 'Admins only');
  run(`DELETE FROM invites WHERE code=? AND chat_id=?`, req.params.code, access.chat.id);
  res.json({ message: 'Invite revoked' });
});

chatsRouter.post('/join/:code', (req, res) => {
  const invite = get(`SELECT * FROM invites WHERE code=?`, req.params.code);
  if (!invite) return fail(res, 404, 'invalid_invite', 'Invite link is invalid');
  if (invite.expires_at && invite.expires_at < new Date().toISOString().replace('T', ' ').slice(0, 19)) return fail(res, 400, 'invite_expired', 'Invite link has expired');
  if (invite.max_uses && invite.uses >= invite.max_uses) return fail(res, 400, 'invite_full', 'Invite link has reached its usage limit');
  const chat = get(`SELECT * FROM chats WHERE id=?`, invite.chat_id);
  if (!chat) return fail(res, 404, 'not_found', 'Chat no longer exists');
  const existing = membership(chat.id, req.user.id);
  if (existing) return res.json({ chat: serializeChat(chat, req.user), message: 'You are already a member' });
  run(`INSERT OR IGNORE INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'member')`, chat.id, req.user.id);
  run(`UPDATE invites SET uses=uses+1 WHERE code=?`, invite.code);
  run(`INSERT INTO messages(chat_id,kind,system_kind,text) VALUES(?,'system','member_joined',?)`, chat.id, `${req.user.display_name} joined via invite link`);
  getIOSafe().to(`c:${chat.id}`).emit('chat:member_joined', { chatId: chat.id, userId: req.user.id, name: req.user.display_name });
  res.json({ chat: serializeChat(get(`SELECT * FROM chats WHERE id=?`, chat.id), req.user) });
});

// ---- join a public chat directly --------------------------------------------------
chatsRouter.post('/:id/join', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  const chat = access.chat;
  if (chat.type === 'direct') return fail(res, 400, 'invalid', 'Cannot join a direct chat');
  if (chat.is_public !== 1 && !access.member) return fail(res, 403, 'private', 'This chat is private — you need an invite link');
  if (access.member?.banned) return fail(res, 403, 'banned', 'You are banned from this chat');
  if (access.member) return res.json({ chat: serializeChat(chat, req.user), message: 'Already a member' });
  run(`INSERT OR IGNORE INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'member')`, chat.id, req.user.id);
  run(`INSERT INTO messages(chat_id,kind,system_kind,text) VALUES(?,'system','member_joined',?)`, chat.id, `${req.user.display_name} joined`);
  getIO()?.to(`c:${chat.id}`).emit('chat:member_joined', { chatId: chat.id, userId: req.user.id, name: req.user.display_name });
  res.json({ chat: serializeChat(get(`SELECT * FROM chats WHERE id=?`, chat.id), req.user) });
});

// ---- my membership controls ---------------------------------------------------
chatsRouter.patch('/:id/membership', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (!access.member) return fail(res, 403, 'forbidden', 'Not a member');
  const { archived, notificationsEnabled, pinned } = req.body || {};
  if (archived !== undefined) run(`UPDATE chat_members SET archived=? WHERE chat_id=? AND user_id=?`, archived ? 1 : 0, access.chat.id, req.user.id);
  if (notificationsEnabled !== undefined) run(`UPDATE chat_members SET notifications_enabled=? WHERE chat_id=? AND user_id=?`, notificationsEnabled ? 1 : 0, access.chat.id, req.user.id);
  if (pinned !== undefined) run(`UPDATE chat_members SET pinned_order=? WHERE chat_id=? AND user_id=?`, pinned ? Date.now() : null, access.chat.id, req.user.id);
  res.json({ chat: serializeChat(access.chat, req.user) });
});

// ---- pinned messages ------------------------------------------------------------
chatsRouter.post('/:id/pin/:messageId', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  const isChannel = access.chat.type === 'channel';
  if (isChannel ? !canManageChat(req.user, access.chat, access.member) : !canModerate(req.user, access.chat, access.member))
    return fail(res, 403, 'forbidden', 'You do not have permission to pin messages here');
  const msg = get(`SELECT * FROM messages WHERE id=? AND chat_id=?`, +req.params.messageId, access.chat.id);
  if (!msg) return fail(res, 404, 'not_found', 'Message not found');
  run(`INSERT OR REPLACE INTO pinned_messages(chat_id,message_id,pinned_by) VALUES(?,?,?)`, access.chat.id, msg.id, req.user.id);
  getIOSafe().to(`c:${access.chat.id}`).emit('message:pinned', { chatId: access.chat.id, message: serializeMessage(msg, req.user, access.chat) });
  res.json({ message: 'Message pinned' });
});

chatsRouter.delete('/:id/pin/:messageId', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (!canModerate(req.user, access.chat, access.member)) return fail(res, 403, 'forbidden', 'No permission');
  run(`DELETE FROM pinned_messages WHERE chat_id=? AND message_id=?`, access.chat.id, +req.params.messageId);
  getIOSafe().to(`c:${access.chat.id}`).emit('message:unpinned', { chatId: access.chat.id, messageId: +req.params.messageId });
  res.json({ message: 'Unpinned' });
});

// ---- mark read -------------------------------------------------------------------
chatsRouter.post('/:id/read', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  const messageId = +req.body?.messageId || get(`SELECT MAX(id) m FROM messages WHERE chat_id=?`, access.chat.id).m || 0;
  run(
    `UPDATE chat_members SET last_read_message_id=MAX(last_read_message_id,?), last_delivered_message_id=MAX(last_delivered_message_id,?) WHERE chat_id=? AND user_id=?`,
    messageId, messageId, access.chat.id, req.user.id
  );
  const others = all(`SELECT user_id FROM chat_members WHERE chat_id=? AND user_id!=?`, access.chat.id, req.user.id).map((r) => r.user_id);
  toUsers(others, 'messages:read', { chatId: access.chat.id, userId: req.user.id, messageId });
  res.json({ ok: true });
});

// ---- channel stats -------------------------------------------------------------------
chatsRouter.get('/:id/stats', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  if (!canManageChat(req.user, access.chat, access.member)) return fail(res, 403, 'forbidden', 'Admins only');
  const stats = {
    members: get(`SELECT COUNT(*) c FROM chat_members WHERE chat_id=? AND banned=0`, access.chat.id).c,
    posts: get(`SELECT COUNT(*) c FROM messages WHERE chat_id=? AND kind!='system'`, access.chat.id).c,
    totalViews: get(`SELECT COALESCE(SUM(views),0) s FROM messages WHERE chat_id=?`, access.chat.id).s,
    reactions: get(`SELECT COUNT(*) c FROM reactions r JOIN messages m ON m.id=r.message_id WHERE m.chat_id=?`, access.chat.id).c,
    last7DaysMembers: all(
      `SELECT date(joined_at) d, COUNT(*) c FROM chat_members WHERE chat_id=? AND joined_at > datetime('now','-7 days') GROUP BY d`, access.chat.id),
    topPosts: all(
      `SELECT id, text, views FROM messages WHERE chat_id=? AND kind!='system' ORDER BY views DESC LIMIT 5`, access.chat.id),
  };
  res.json({ stats });
});

// ---- media grid for a chat -------------------------------------------------------------------
chatsRouter.get('/:id/media', (req, res) => {
  const access = requireChatAccess(req.user, +req.params.id);
  if (access.error) return fail(res, access.error.status, access.error.code, access.error.message);
  const kind = ['image', 'video', 'voice', 'audio', 'document'].includes(req.query.kind) ? req.query.kind : null;
  const limit = Math.min(100, +req.query.limit || 50);
  const before = +req.query.before || 1e15;
  const rows = all(
    `SELECT m.* FROM messages m
     JOIN attachments a ON a.id=m.attachment_id
     LEFT JOIN message_deletions d ON d.message_id=m.id AND d.user_id=?
     WHERE m.chat_id=? AND d.message_id IS NULL AND m.id < ? ${kind ? `AND m.kind='${kind}'` : `AND m.kind IN ('image','video','voice','audio','document')`}
     ORDER BY m.id DESC LIMIT ?`, req.user.id, access.chat.id, before, limit
  );
  res.json({ items: rows.map((m) => serializeMessage(m, req.user, access.chat)) });
});

// ---- discover public chats -------------------------------------------------------------------
chatsRouter.get('/discover/public', searchLimiter, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const type = ['group', 'channel'].includes(req.query.type) ? req.query.type : null;
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = all(
    `SELECT * FROM chats WHERE is_public=1 ${type ? `AND type='${type}'` : ''} AND (name LIKE ? OR username LIKE ? OR about LIKE ?)
     ORDER BY CASE WHEN username=? THEN 0 ELSE 1 END, id DESC LIMIT 30`,
    like, like, like, q.replace(/^@/, '')
  );
  res.json({ results: rows.map((c) => serializeChat(c, req.user)) });
});

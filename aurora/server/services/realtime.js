import { get, all, run, now } from '../db/index.js';

/**
 * Realtime push + presence. One process → Socket.IO in-memory adapter.
 * Production note: add @socket.io/redis-adapter to scale across nodes.
 */
let io = null;
export function setIO(_io) { io = _io; }
export function getIO() { return io; }

const presence = new Map(); // userId -> Set<socketId>

export function addPresence(userId, socketId) {
  if (!presence.has(userId)) presence.set(userId, new Set());
  presence.get(userId).add(socketId);
  const wasOffline = presence.get(userId).size === 1;
  if (wasOffline) {
    run(`UPDATE users SET status='online' WHERE id=?`, userId);
    toContactsOf(userId, 'presence', { userId, online: true });
  }
}

export function removePresence(userId, socketId) {
  const set = presence.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) {
    presence.delete(userId);
    run(`UPDATE users SET status='offline', last_seen_at=? WHERE id=?`, now(), userId);
    toContactsOf(userId, 'presence', { userId, online: false, lastSeen: now() });
  }
}

export const isOnline = (userId) => presence.has(userId);

/** "contacts" = users sharing a direct chat (Aurora discovers people via username/email, not phonebook). */
export function contactsOf(userId) {
  return all(
    `SELECT DISTINCT cm2.user_id AS uid
     FROM chat_members cm1
     JOIN chats c ON c.id = cm1.chat_id AND c.type='direct'
     JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id != cm1.user_id
     WHERE cm1.user_id = ?`, userId
  ).map((r) => r.uid);
}

function toContactsOf(userId, event, payload) {
  if (!io) return;
  for (const uid of contactsOf(userId)) io.to(`u:${uid}`).emit(event, payload);
}

export function toUser(userId, event, payload) { io?.to(`u:${userId}`).emit(event, payload); }
export function toUsers(userIds, event, payload) {
  if (!io) return;
  for (const uid of new Set(userIds)) io.to(`u:${uid}`).emit(event, payload);
}
export function toChat(chatId, event, payload, exceptUserId) {
  if (!io) return;
  const room = io.to(`c:${chatId}`);
  room.emit(event, payload);
  if (exceptUserId) io.to(`u:${exceptUserId}`).emit(`${event}:self-ack`, payload);
}
export function toChatMembers(chatId, event, payload) {
  const members = all(`SELECT user_id FROM chat_members WHERE chat_id=? AND banned=0`, chatId).map((m) => m.user_id);
  toUsers(members, event, payload);
}

export function createNotification(userId, { type, chatId = null, messageId = null, storyId = null, actorId = null, title = '', body = '' }) {
  const info = run(
    `INSERT INTO notifications(user_id,type,chat_id,message_id,story_id,actor_id,title,body) VALUES(?,?,?,?,?,?,?,?)`,
    userId, type, chatId, messageId, storyId, actorId, title, body
  );
  const notif = get(`SELECT * FROM notifications WHERE id=?`, info.lastInsertRowid);
  toUser(userId, 'notification', notif);
  return notif;
}

export function kickUser(userId, reason) {
  io?.to(`u:${userId}`).emit('forced_logout', { reason });
}

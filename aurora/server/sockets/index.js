import { all, get, run } from '../db/index.js';
import { verifyAccessToken } from '../services/tokens.js';
import { addPresence, removePresence, setIO, toUser, getIO } from '../services/realtime.js';
import { membership } from '../services/access.js';

export function initSockets(io) {
  setIO(io);

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    const payload = verifyAccessToken(String(token || ''));
    if (!payload) return next(new Error('unauthorized'));
    const user = get(`SELECT * FROM users WHERE id=? AND suspended=0`, payload.sub);
    if (!user) return next(new Error('unauthorized'));
    socket.userId = user.id;
    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    socket.join(`u:${userId}`);

    // join all chat rooms
    const chats = all(`SELECT chat_id FROM chat_members WHERE user_id=? AND banned=0`, userId);
    for (const c of chats) socket.join(`c:${c.chat_id}`);
    // public channels are open rooms too
    for (const c of all(`SELECT id FROM chats WHERE is_public=1 AND type='channel'`)) socket.join(`c:${c.id}`);

    addPresence(userId, socket.id);
    socket.emit('connected', { userId, ts: Date.now() });

    // dynamically join rooms when new chats arrive
    socket.on('chat:join', ({ chatId }) => {
      const chat = get(`SELECT * FROM chats WHERE id=?`, +chatId);
      if (!chat) return;
      if (chat.is_public || membership(chat.id, userId) || userId === chat.owner_id) socket.join(`c:${chat.id}`);
    });
    socket.on('chat:leave', ({ chatId }) => socket.leave(`c:${+chatId}`));

    socket.on('typing', ({ chatId, isTyping }) => {
      if (!chatId) return;
      socket.to(`c:${chatId}`).emit('typing', {
        chatId: +chatId, userId,
        name: socket.user.display_name,
        isTyping: !!isTyping,
      });
    });

    socket.on('recording', ({ chatId, isRecording }) => {
      if (!chatId) return;
      socket.to(`c:${chatId}`).emit('recording', {
        chatId: +chatId, userId, name: socket.user.display_name, isRecording: !!isRecording,
      });
    });

    socket.on('messages:read', ({ chatId, messageId }) => {
      if (!chatId || !messageId) return;
      const m = membership(+chatId, userId);
      if (!m) return;
      run(
        `UPDATE chat_members SET last_read_message_id=MAX(last_read_message_id,?), last_delivered_message_id=MAX(last_delivered_message_id,?) WHERE chat_id=? AND user_id=?`,
        +messageId, +messageId, +chatId, userId
      );
      const others = all(`SELECT user_id FROM chat_members WHERE chat_id=? AND user_id!=?`, +chatId, userId).map((r) => r.user_id);
      for (const uid of others) getIO()?.to(`u:${uid}`).emit('messages:read', { chatId: +chatId, userId, messageId: +messageId });
    });

    socket.on('ping:app', () => socket.emit('pong:app', { ts: Date.now() }));

    socket.on('disconnect', () => removePresence(userId, socket.id));
  });

  // graceful heartbeat cleanup for crashed clients
  setInterval(() => {
    const onlineIds = new Set();
    for (const [, s] of io.sockets.sockets) onlineIds.add(s.userId);
    run(`UPDATE users SET status='offline', last_seen_at=datetime('now') WHERE status='online' AND id NOT IN (${[...onlineIds].join(',') || 'NULL'})`);
  }, 60_000).unref();
}

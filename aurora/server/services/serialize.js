import { get, all } from '../db/index.js';
import { canSeeLastSeen, canSeeProfilePhoto, isBlockedBetween } from './access.js';
import { isOnline } from './realtime.js';

/** Shaping DB rows into API payloads with privacy rules applied. */

export function serializeUser(user, viewer) {
  const base = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    bio: user.bio,
    role: user.role,
    createdAt: user.created_at,
    suspended: !!user.suspended,
  };
  if (!viewer || viewer.id === user.id) {
    base.avatar = user.avatar_attachment_id ? `/api/files/${user.avatar_attachment_id}` : null;
    base.online = isOnline(user.id);
    base.lastSeen = user.last_seen_at;
    return base;
  }
  base.avatar = canSeeProfilePhoto(viewer, user) && user.avatar_attachment_id ? `/api/files/${user.avatar_attachment_id}` : null;
  if (canSeeLastSeen(viewer, user)) {
    base.online = isOnline(user.id);
    base.lastSeen = user.last_seen_at;
  } else {
    base.online = false;
    base.lastSeenHidden = true;
  }
  base.blocked = isBlockedBetween(viewer.id, user.id);
  base.blockedByMe = !!get(`SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?`, viewer.id, user.id);
  return base;
}

export function isContact(a, b) {
  return !!get(
    `SELECT 1 FROM chat_members cm1 JOIN chats c ON c.id=cm1.chat_id AND c.type='direct'
     JOIN chat_members cm2 ON cm2.chat_id=c.id WHERE cm1.user_id=? AND cm2.user_id=?`, a, b
  );
}

export function serializeAttachment(a, viewer) {
  if (!a) return null;
  return {
    id: a.id, kind: a.kind, mime: a.mime, filename: a.filename, size: a.size,
    url: `/api/files/${a.id}`, thumbUrl: a.thumb_path ? `/api/files/${a.id}?thumb=1` : null,
    width: a.width, height: a.height, duration: a.duration,
    waveform: a.waveform ? JSON.parse(a.waveform) : null,
  };
}

export function serializeMessage(msg, viewer, chat) {
  const out = {
    id: msg.id,
    chatId: msg.chat_id,
    senderId: msg.anonymous ? null : msg.sender_id,
    anonymous: !!msg.anonymous,
    kind: msg.kind,
    systemKind: msg.system_kind,
    text: msg.text,
    replyToId: msg.reply_to_id,
    parentPostId: msg.parent_post_id,
    fwdFrom: msg.fwd_from ? JSON.parse(msg.fwd_from) : null,
    editedAt: msg.edited_at,
    createdAt: msg.created_at,
    views: msg.views,
    attachment: msg.attachment_id ? serializeAttachment(get(`SELECT * FROM attachments WHERE id=?`, msg.attachment_id), viewer) : null,
  };
  if (msg.sender_id && !msg.anonymous) {
    const sender = get(`SELECT id,username,display_name,avatar_attachment_id FROM users WHERE id=?`, msg.sender_id);
    if (sender) out.sender = {
      id: sender.id, username: sender.username, displayName: sender.display_name,
      avatar: sender.avatar_attachment_id ? `/api/files/${sender.avatar_attachment_id}` : null,
    };
  }
  if (msg.reply_to_id) {
    const r = get(`SELECT id,sender_id,kind,text,attachment_id FROM messages WHERE id=?`, msg.reply_to_id);
    if (r) {
      const rs = r.sender_id ? get(`SELECT display_name FROM users WHERE id=?`, r.sender_id) : null;
      out.replyTo = {
        id: r.id, kind: r.kind,
        text: (r.text || '').slice(0, 120),
        senderName: rs?.display_name || 'Channel',
        attachment: r.attachment_id ? serializeAttachment(get(`SELECT * FROM attachments WHERE id=?`, r.attachment_id), viewer) : null,
      };
    }
  }
  out.reactions = all(
    `SELECT r.emoji, r.user_id, u.display_name FROM reactions r JOIN users u ON u.id=r.user_id WHERE r.message_id=?`, msg.id
  ).map((r) => ({ emoji: r.emoji, userId: r.user_id, name: r.display_name }));
  return out;
}

export function serializeChat(chat, viewer, member) {
  member = member || get(`SELECT * FROM chat_members WHERE chat_id=? AND user_id=?`, chat.id, viewer.id);
  const out = {
    id: chat.id, type: chat.type, name: chat.name, about: chat.about,
    avatar: chat.avatar_attachment_id ? `/api/files/${chat.avatar_attachment_id}` : null,
    ownerId: chat.owner_id, username: chat.username, isPublic: !!chat.is_public,
    settings: JSON.parse(chat.settings || '{}'),
    createdAt: chat.created_at,
    myRole: member?.role || null,
    muted: !!(member?.muted_until && member.muted_until > new Date().toISOString().replace('T', ' ').slice(0, 19)),
    notificationsEnabled: member ? !!member.notifications_enabled : true,
    archived: member ? !!member.archived : false,
    pinnedOrder: member?.pinned_order ?? null,
    lastReadMessageId: member?.last_read_message_id || 0,
  };
  if (chat.type === 'direct') {
    const other = get(
      `SELECT u.* FROM chat_members cm JOIN users u ON u.id=cm.user_id WHERE cm.chat_id=? AND u.id!=?`, chat.id, viewer.id
    );
    if (other) {
      out.peer = serializeUser(other, viewer);
      out.name = other.display_name;
      out.avatar = out.peer.avatar;
      out.online = out.peer.online;
    }
  } else {
    out.memberCount = get(`SELECT COUNT(*) c FROM chat_members WHERE chat_id=? AND banned=0`, chat.id).c;
    if (chat.type === 'channel') out.subscriberCount = out.memberCount;
  }
  const last = get(
    `SELECT m.* FROM messages m
     LEFT JOIN message_deletions d ON d.message_id=m.id AND d.user_id=?
     WHERE m.chat_id=? AND d.message_id IS NULL
     ORDER BY m.id DESC LIMIT 1`, viewer.id, chat.id
  );
  out.lastMessage = last ? serializeMessage(last, viewer, chat) : null;
  out.unreadCount = get(
    `SELECT COUNT(*) c FROM messages m
     LEFT JOIN message_deletions d ON d.message_id=m.id AND d.user_id=?
     WHERE m.chat_id=? AND m.id > ? AND (m.sender_id != ? OR m.sender_id IS NULL) AND d.message_id IS NULL`,
    viewer.id, chat.id, member?.last_read_message_id || 0, viewer.id
  ).c;
  out.pinnedMessages = all(
    `SELECT m.id FROM pinned_messages p JOIN messages m ON m.id=p.message_id WHERE p.chat_id=? ORDER BY p.pinned_at DESC LIMIT 10`, chat.id
  ).map((r) => r.id);
  return out;
}

export function serializeStory(story, viewer) {
  const user = get(`SELECT * FROM users WHERE id=?`, story.user_id);
  return {
    id: story.id,
    user: serializeUser(user, viewer),
    attachment: serializeAttachment(get(`SELECT * FROM attachments WHERE id=?`, story.attachment_id), viewer),
    caption: story.caption,
    overlay: JSON.parse(story.overlay || '[]'),
    privacy: story.privacy,
    expiresAt: story.expires_at,
    createdAt: story.created_at,
    viewCount: get(`SELECT COUNT(*) c FROM story_views WHERE story_id=?`, story.id).c,
    myReaction: get(`SELECT reaction FROM story_views WHERE story_id=? AND viewer_id=?`, story.id, viewer?.id)?.reaction || null,
    viewedByMe: !!get(`SELECT 1 FROM story_views WHERE story_id=? AND viewer_id=?`, story.id, viewer?.id),
    isMine: viewer ? story.user_id === viewer.id : false,
  };
}

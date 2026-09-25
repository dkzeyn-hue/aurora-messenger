import { get, all, now } from '../db/index.js';

/**
 * Central authorization layer. EVERY route/socket operation goes through these
 * checks so a user can never touch another user's private data.
 */

export function membership(chatId, userId) {
  return get(`SELECT * FROM chat_members WHERE chat_id=? AND user_id=? AND banned=0`, chatId, userId);
}

export function getChat(chatId) {
  return get(`SELECT * FROM chats WHERE id=?`, chatId);
}

export function requireChatAccess(user, chatId) {
  const chat = getChat(chatId);
  if (!chat) return { error: { status: 404, code: 'chat_not_found', message: 'Chat not found' } };
  if (user.role === 'admin') return { chat, member: membership(chatId, user.id) || null };
  if (chat.type === 'channel' && chat.is_public) {
    // public channels are readable by anyone logged in
    return { chat, member: membership(chatId, user.id) || null };
  }
  const member = membership(chatId, user.id);
  if (!member) return { error: { status: 403, code: 'forbidden', message: 'You do not have access to this chat' } };
  return { chat, member };
}

export const roleRank = { member: 0, moderator: 1, admin: 2, owner: 3 };
export function canManageChat(user, chat, member) {
  if (user.role === 'admin') return true;
  if (!member) return false;
  return roleRank[member.role] >= roleRank.admin;
}
export function canModerate(user, chat, member) {
  if (user.role === 'admin') return true;
  if (!member) return false;
  return roleRank[member.role] >= roleRank.moderator;
}

export function isBlockedBetween(a, b) {
  return !!get(`SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)`, a, b, b, a);
}

export function canDirectMessage(user, targetId) {
  const target = get(`SELECT * FROM users WHERE id=? AND suspended=0`, targetId);
  if (!target) return { ok: false, message: 'User not found' };
  const settings = getSettings(target.id);
  const who = settings.privacy.whoCanMessage || 'everyone';
  if (who === 'nobody') return { ok: false, message: 'This user does not accept direct messages' };
  if (who === 'contacts' && !get(`SELECT 1 FROM chat_members cm1 JOIN chats c ON c.id=cm1.chat_id AND c.type='direct' JOIN chat_members cm2 ON cm2.chat_id=c.id WHERE cm1.user_id=? AND cm2.user_id=?`, target.id, user.id)) {
    return { ok: false, message: 'This user only accepts messages from people they have chatted with' };
  }
  if (isBlockedBetween(user.id, targetId)) return { ok: false, message: 'You cannot message this user', blocked: true };
  return { ok: true, target };
}

export function canAddToGroup(user, targetId) {
  const settings = getSettings(targetId);
  const who = settings.privacy.whoCanAddToGroups || 'everyone';
  if (who === 'nobody') return false;
  if (who === 'contacts') {
    return !!get(`SELECT 1 FROM chat_members cm1 JOIN chats c ON c.id=cm1.chat_id AND c.type='direct' JOIN chat_members cm2 ON cm2.chat_id=c.id WHERE cm1.user_id=? AND cm2.user_id=?`, targetId, user.id);
  }
  return !isBlockedBetween(user.id, targetId);
}

export function getSettings(userId) {
  const row = get(`SELECT * FROM user_settings WHERE user_id=?`, userId);
  const parse = (s, d) => { try { return { ...d, ...JSON.parse(s || '{}') }; } catch { return d; } };
  return {
    privacy: parse(row?.privacy, {
      lastSeen: 'everyone', profilePhoto: 'everyone', whoCanMessage: 'everyone',
      whoCanAddToGroups: 'everyone', whoCanFindByEmail: 'everyone', whoCanCall: 'everyone',
      forwardProtection: false, showEmailToMutual: false,
    }),
    notifications: parse(row?.notifications, { sound: true, desktop: true, preview: true, groupsMuted: false }),
    appearance: parse(row?.appearance, { theme: 'system', accent: '#7c5cff', wallpaper: 'aurora', fontSize: 'medium', bubbles: 'rounded' }),
    data: parse(row?.data, { autoplayMedia: 'wifi', saveToGallery: false, cacheMedia: true }),
  };
}

export function canSeeStory(viewer, story) {
  if (viewer.id === story.user_id) return true;
  if (isBlockedBetween(viewer.id, story.user_id)) return false;
  const settings = getSettings(story.user_id);
  if (settings.privacy.lastSeen === 'nobody' && story.privacy === 'everyone') { /* stories still allowed */ }
  switch (story.privacy) {
    case 'everyone': return true;
    case 'nobody': return false;
    case 'selected': {
      const sel = JSON.parse(story.selected_users || '[]');
      return sel.includes(viewer.id);
    }
    case 'contacts': {
      const settingsV = getSettings(story.user_id);
      const who = settingsV.privacy.whoCanSeeStoriesDefault || story.privacy;
      return !!get(
        `SELECT 1 FROM chat_members cm1 JOIN chats c ON c.id=cm1.chat_id AND c.type='direct' JOIN chat_members cm2 ON cm2.user_id=? AND cm2.chat_id=c.id WHERE cm1.user_id=?`,
        viewer.id, story.user_id, story.user_id
      );
    }
    default: return false;
  }
}

/** Viewer-dependent field privacy. */
export function canSeeLastSeen(viewer, target) {
  if (viewer.id === target.id) return true;
  const v = getSettings(target.id).privacy.lastSeen;
  if (v === 'everyone') return true;
  if (v === 'nobody') return false;
  return !!get(`SELECT 1 FROM chat_members cm1 JOIN chats c ON c.id=cm1.chat_id AND c.type='direct' JOIN chat_members cm2 ON cm2.user_id=? AND cm2.chat_id=c.id WHERE cm1.user_id=?`, viewer.id, target.id, target.id);
}
export function canSeeProfilePhoto(viewer, target) {
  if (viewer.id === target.id) return true;
  const v = getSettings(target.id).privacy.profilePhoto;
  if (v === 'everyone') return true;
  if (v === 'nobody') return false;
  return !!get(`SELECT 1 FROM chat_members cm1 JOIN chats c ON c.id=cm1.chat_id AND c.type='direct' JOIN chat_members cm2 ON cm2.user_id=? AND cm2.chat_id=c.id WHERE cm1.user_id=?`, viewer.id, target.id, target.id);
}
export function canFindByEmail(viewer, target) {
  if (viewer.id === target.id) return true;
  return getSettings(target.id).privacy.whoCanFindByEmail !== 'nobody';
}

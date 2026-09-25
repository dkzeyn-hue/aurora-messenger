import express from 'express';
import { get, all, run, tx, now, platformSetting } from '../db/index.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../services/passwords.js';
import { signAccessToken, createSession, rotateRefreshToken, revokeSession, revokeAllSessions } from '../services/tokens.js';
import { recordLoginAttempt, loginBlocked } from '../services/spam.js';
import { authenticate, clientIp, deviceLabel, fail } from '../middleware/auth.js';
import { authLimiter, loginLimiter } from '../services/ratelimit.js';
import { kickUser } from '../services/realtime.js';
import { serializeUser } from '../services/serialize.js';

/**
 * Authentication: username + password ONLY.
 * No email, no phone number, no OTP, no external providers.
 * The `users.email` column still exists in the schema for legacy data but is
 * nullable and unused — new accounts are created with NULL email.
 */

export const authRouter = express.Router();

const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

function usernameAvailable(username) {
  const u = String(username || '').toLowerCase();
  if (!USERNAME_RE.test(u)) return { ok: false, code: 'invalid_username', message: 'Username must be 3–32 characters: letters, numbers, underscore' };
  if (get(`SELECT 1 FROM banned_usernames WHERE username=?`, u)) return { ok: false, code: 'username_reserved', message: 'This username is reserved' };
  if (get(`SELECT 1 FROM users WHERE username=?`, u)) return { ok: false, code: 'username_taken', message: 'This username is already taken' };
  return { ok: true };
}

/** After registration: welcome DM + join official channel. */
function onboardUser(userId) {
  const admin = get(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`);
  if (admin && admin.id !== userId) {
    const info = run(`INSERT INTO chats(type,name,owner_id) VALUES('direct','',?)`, admin.id);
    const chatId = info.lastInsertRowid;
    run(`INSERT INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'owner')`, chatId, admin.id);
    run(`INSERT INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'member')`, chatId, userId);
    run(
      `INSERT INTO messages(chat_id,sender_id,kind,text) VALUES(?,?,'text',?)`,
      chatId, admin.id,
      `👋 Welcome to Aurora!\n\nHere are a few tips to get started:\n• Tap the ✏️ button to start a chat by @username\n• Create groups & channels from the same menu\n• Share your first Story from the top of the Chats screen\n• Set your privacy rules in Settings → Privacy\n\n⚠️ Important: Aurora has no email or phone recovery — if you forget your password, your account cannot be recovered. Store it safely!\n\nHappy chatting! — The Aurora Team`
    );
  }
  const official = get(`SELECT id FROM chats WHERE username='aurora'`);
  if (official) {
    run(`INSERT OR IGNORE INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'member')`, official.id, userId);
  }
}

// ---- register (username + display name + password) ---------------------------
authRouter.post('/register', authLimiter, (req, res) => {
  try {
    if (!platformSetting('limits', {}).signupEnabled) return fail(res, 403, 'signup_disabled', 'Sign-up is currently disabled');
    const { username, displayName, password, confirmPassword } = req.body || {};

    const nameCheck = usernameAvailable(username);
    if (!nameCheck.ok) return fail(res, nameCheck.code === 'username_taken' ? 409 : 400, nameCheck.code, nameCheck.message);

    const dn = String(displayName || '').trim();
    if (dn.length < 1 || dn.length > 64) return fail(res, 400, 'invalid_name', 'Display name must be 1–64 characters');

    const strength = validatePasswordStrength(String(password || ''));
    if (!strength.ok) return fail(res, 400, 'weak_password', strength.errors.join('. '));
    if (password !== confirmPassword) return fail(res, 400, 'password_mismatch', 'Passwords do not match');

    let userId;
    try {
      userId = tx(() => {
        const info = run(
          `INSERT INTO users(email,email_verified,password_hash,username,display_name,last_ip) VALUES(NULL,1,?,?,?,?)`,
          hashPassword(password), String(username).toLowerCase(), dn, clientIp(req)
        );
        run(`INSERT INTO user_settings(user_id) VALUES(?)`, info.lastInsertRowid);
        return info.lastInsertRowid;
      })();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return fail(res, 409, 'username_taken', 'That username is already taken');
      throw e;
    }

    onboardUser(userId);

    // auto-login: hand back a session immediately
    const user = get(`SELECT * FROM users WHERE id=?`, userId);
    const { sessionId, refreshToken } = createSession(user.id, deviceLabel(req), clientIp(req));
    const accessToken = signAccessToken(user);
    res.status(201).json({
      accessToken, refreshToken, sessionId,
      user: serializeUser(user, user),
      message: 'Account created — welcome to Aurora!',
    });
  } catch (e) {
    console.error(e); fail(res, 500, 'server_error', 'Something went wrong. Please try again.');
  }
});

authRouter.get('/username-available', (req, res) => {
  res.json(usernameAvailable(req.query.username));
});

// ---- login (username + password) ----------------------------------------------
authRouter.post('/login', loginLimiter, (req, res) => {
  const username = String(req.body?.username || '').trim().replace(/^@/, '').toLowerCase();
  const password = String(req.body?.password || '');
  const ip = clientIp(req);

  const block = loginBlocked(username, ip);
  if (block.blocked) { recordLoginAttempt(username, ip, false); return fail(res, 429, 'login_blocked', block.reason); }

  const user = get(`SELECT * FROM users WHERE username=?`, username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginAttempt(username, ip, false);
    return fail(res, 401, 'invalid_credentials', 'Incorrect username or password');
  }
  if (user.suspended) {
    recordLoginAttempt(username, ip, false);
    return fail(res, 403, 'account_suspended', `This account is suspended${user.suspended_reason ? ': ' + user.suspended_reason : ''}`);
  }
  recordLoginAttempt(username, ip, true);

  const { sessionId, refreshToken } = createSession(user.id, deviceLabel(req), ip);
  const accessToken = signAccessToken(user);
  run(`UPDATE users SET last_ip=? WHERE id=?`, ip, user.id);
  res.json({
    accessToken, refreshToken, sessionId,
    user: serializeUser(get(`SELECT * FROM users WHERE id=?`, user.id), user),
  });
});

authRouter.post('/refresh', (req, res) => {
  const result = rotateRefreshToken(req.body?.refreshToken, deviceLabel(req), clientIp(req));
  if (!result) return fail(res, 401, 'invalid_refresh', 'Session expired or revoked. Please sign in again.');
  const accessToken = signAccessToken(result.user);
  res.json({ accessToken, refreshToken: result.refreshToken, sessionId: result.sessionId });
});

authRouter.post('/logout', authenticate(), (req, res) => {
  const sessionId = req.body?.sessionId || req.sessionId;
  if (sessionId) revokeSession(sessionId, req.user.id);
  res.json({ message: 'Signed out' });
});

authRouter.post('/logout-all', authenticate(), (req, res) => {
  const n = revokeAllSessions(req.user.id);
  kickUser(req.user.id, 'Logged out from all devices');
  res.json({ message: `Signed out from ${n} device(s)` });
});

authRouter.get('/sessions', authenticate(), (req, res) => {
  const sessions = all(
    `SELECT id, device, ip, created_at, last_used_at FROM sessions
     WHERE user_id=? AND revoked=0 AND expires_at > ? ORDER BY last_used_at DESC`, req.user.id, now()
  ).map((s) => ({
    id: s.id, device: s.device, ip: s.ip, createdAt: s.created_at,
    lastUsedAt: s.last_used_at, isCurrent: s.id === req.currentSessionId,
  }));
  res.json({ sessions });
});

authRouter.delete('/sessions/:id', authenticate(), (req, res) => {
  if (!revokeSession(req.params.id, req.user.id)) return fail(res, 404, 'not_found', 'Session not found');
  getIO()?.to(`u:${req.user.id}`).emit('session_revoked', { sessionId: req.params.id });
  res.json({ message: 'Device signed out' });
});

// ---- change password (no email recovery exists — this is the only reset path) ----
authRouter.post('/change-password', authenticate(), (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || ''), req.user.password_hash))
    return fail(res, 400, 'wrong_password', 'Current password is incorrect');
  const strength = validatePasswordStrength(String(newPassword || ''));
  if (!strength.ok) return fail(res, 400, 'weak_password', strength.errors.join('. '));
  run(`UPDATE users SET password_hash=? WHERE id=?`, hashPassword(newPassword), req.user.id);
  res.json({ message: 'Password changed' });
});

// ---- account deletion -----------------------------------------------------
authRouter.delete('/account', authenticate(), (req, res) => {
  if (!verifyPassword(String(req.body?.password || ''), req.user.password_hash))
    return fail(res, 400, 'wrong_password', 'Enter your password to confirm account deletion');

  tx(() => {
    const uid = req.user.id;
    const chatIds = all(`SELECT chat_id FROM chat_members WHERE user_id=?`, uid).map((r) => r.chat_id);
    for (const cid of chatIds) {
      const chat = get(`SELECT * FROM chats WHERE id=?`, cid);
      if (!chat) continue;
      if (chat.type === 'direct' || chat.owner_id === uid) {
        const msgIds = all(`SELECT id, attachment_id FROM messages WHERE chat_id=?`, cid);
        for (const m of msgIds) {
          run(`DELETE FROM reactions WHERE message_id=?`, m.id);
          run(`DELETE FROM message_deletions WHERE message_id=?`, m.id);
          run(`DELETE FROM pinned_messages WHERE message_id=?`, m.id);
          if (m.attachment_id) run(`DELETE FROM attachments WHERE id=? AND owner_id=?`, m.attachment_id, uid);
        }
        run(`DELETE FROM messages WHERE chat_id=?`, cid);
        run(`DELETE FROM pinned_messages WHERE chat_id=?`, cid);
        run(`DELETE FROM invites WHERE chat_id=?`, cid);
        run(`DELETE FROM chat_members WHERE chat_id=?`, cid);
        run(`DELETE FROM chats WHERE id=?`, cid);
      } else {
        run(`DELETE FROM chat_members WHERE chat_id=? AND user_id=?`, cid, uid);
        run(
          `INSERT INTO messages(chat_id,sender_id,kind,system_kind,text) VALUES(?,NULL,'system','member_left',?)`,
          cid, `${req.user.display_name} left the ${chat.type}`
        );
      }
    }
    const storyIds = all(`SELECT id, attachment_id FROM stories WHERE user_id=?`, uid);
    for (const s of storyIds) {
      run(`DELETE FROM story_views WHERE story_id=?`, s.id);
      run(`DELETE FROM attachments WHERE id=? AND owner_id=?`, s.attachment_id, uid);
    }
    run(`DELETE FROM stories WHERE user_id=?`, uid);
    run(`DELETE FROM story_views WHERE viewer_id=?`, uid);
    run(`DELETE FROM notifications WHERE user_id=?`, uid);
    run(`DELETE FROM blocks WHERE blocker_id=? OR blocked_id=?`, uid, uid);
    run(`DELETE FROM reports WHERE reporter_id=?`, uid);
    run(`DELETE FROM sessions WHERE user_id=?`, uid);
    run(`DELETE FROM email_tokens WHERE user_id=?`, uid);
    run(`DELETE FROM user_settings WHERE user_id=?`, uid);
    run(`DELETE FROM reactions WHERE user_id=?`, uid);
    run(`DELETE FROM message_deletions WHERE user_id=?`, uid);
    run(`DELETE FROM users WHERE id=?`, uid);
  })();

  kickUser(req.user.id, 'Account deleted');
  res.json({ message: 'Your account and data have been permanently deleted.' });
});

authRouter.get('/me', authenticate(), (req, res) => {
  res.json({ user: serializeUser(req.user, req.user) });
});

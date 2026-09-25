import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { sha256, randomToken, uuid } from './passwords.js';
import { db, get, run, now } from '../db/index.js';

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.accessTokenTtl,
  });
}

export function verifyAccessToken(token) {
  try { return jwt.verify(token, config.jwtSecret); } catch { return null; }
}

export function createSession(userId, device, ip) {
  const id = uuid();
  const refreshToken = randomToken(48);
  const expires = new Date(Date.now() + config.refreshTokenTtlDays * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  run(
    `INSERT INTO sessions(id,user_id,refresh_hash,device,ip,expires_at) VALUES(?,?,?,?,?,?)`,
    id, userId, sha256(refreshToken), device || 'Unknown device', ip || null, expires
  );
  return { sessionId: id, refreshToken: `${id}.${refreshToken}` };
}

export function rotateRefreshToken(presented, device, ip) {
  const [sessionId, secret] = String(presented || '').split('.');
  if (!sessionId || !secret) return null;
  const session = get(`SELECT * FROM sessions WHERE id=? AND revoked=0`, sessionId);
  if (!session) return null;
  if (sha256(secret) !== session.refresh_hash) {
    // possible token theft — revoke the whole session
    run(`UPDATE sessions SET revoked=1 WHERE id=?`, sessionId);
    return null;
  }
  if (session.expires_at < now()) return null;
  const user = get(`SELECT * FROM users WHERE id=? AND suspended=0`, session.user_id);
  if (!user) return null;
  const newSecret = randomToken(48);
  const expires = new Date(Date.now() + config.refreshTokenTtlDays * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  run(
    `UPDATE sessions SET refresh_hash=?, last_used_at=?, expires_at=?, device=COALESCE(?,device), ip=COALESCE(?,ip) WHERE id=?`,
    sha256(newSecret), now(), expires, device || null, ip || null, sessionId
  );
  return { user, sessionId, refreshToken: `${sessionId}.${newSecret}` };
}

export function revokeSession(sessionId, userId) {
  return run(`UPDATE sessions SET revoked=1 WHERE id=? AND user_id=?`, sessionId, userId).changes > 0;
}
export function revokeAllSessions(userId, exceptId) {
  if (exceptId) return run(`UPDATE sessions SET revoked=1 WHERE user_id=? AND id!=?`, userId, exceptId).changes;
  return run(`UPDATE sessions SET revoked=1 WHERE user_id=?`, userId).changes;
}

export function createEmailToken(userId, type, ttlMinutes) {
  const token = randomToken(24);
  run(
    `INSERT INTO email_tokens(user_id,type,token_hash,expires_at) VALUES(?,?,?,?)`,
    userId, type, sha256(token),
    new Date(Date.now() + ttlMinutes * 60000).toISOString().replace('T', ' ').slice(0, 19)
  );
  return token;
}

export function consumeEmailToken(token, type) {
  const row = get(
    `SELECT * FROM email_tokens WHERE token_hash=? AND type=? AND used=0 AND expires_at > ?`,
    sha256(String(token || '')), type, now()
  );
  if (!row) return null;
  run(`UPDATE email_tokens SET used=1 WHERE id=?`, row.id);
  return row;
}

import { get } from '../db/index.js';
import { verifyAccessToken } from '../services/tokens.js';
import { isRestricted } from '../services/spam.js';

function extractToken(req) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  if (req.query?.token) return String(req.query.token); // used for file downloads / websocket upgrade
  return null;
}

export function authenticate(required = true) {
  return (req, res, next) => {
    const token = extractToken(req);
    if (!token) {
      if (!required) return next();
      return res.status(401).json({ error: 'unauthorized', message: 'Sign in to continue' });
    }
    const payload = verifyAccessToken(token);
    if (!payload) {
      if (!required) return next();
      return res.status(401).json({ error: 'token_expired', message: 'Session expired. Please sign in again.' });
    }
    const user = get(`SELECT * FROM users WHERE id=?`, payload.sub);
    if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Account no longer exists' });
    if (user.suspended) {
      return res.status(403).json({ error: 'account_suspended', message: `Account suspended${user.suspended_reason ? ': ' + user.suspended_reason : ''}` });
    }
    req.user = user;
    if (isRestricted(user)) {
      return res.status(429).json({ error: 'restricted', message: 'Your account is temporarily restricted for suspicious activity.' });
    }
    next();
  };
}

/**
 * Legacy middleware — email verification no longer exists (username-only auth).
 * Kept as a pass-through so existing route declarations stay unchanged.
 */
export function requireVerifiedEmail(req, res, next) {
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', message: 'Administrator access required' });
  }
  next();
}

export function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (Array.isArray(xf) ? xf[0] : xf?.split(',')[0])?.trim() || req.socket?.remoteAddress || '';
}

export function deviceLabel(req) {
  const ua = req.headers['user-agent'] || '';
  if (req.body?.device) return String(req.body.device).slice(0, 120);
  if (/android/i.test(ua)) return 'Android · ' + (ua.match(/Android [\d.]+/)?.[0] || '');
  if (/iphone|ipad/i.test(ua)) return 'iOS device';
  if (/windows/i.test(ua)) return 'Windows · ' + (ua.match(/(Chrome|Firefox|Edg)\/\d+/)?.[0] || 'browser');
  if (/macintosh/i.test(ua)) return 'macOS · browser';
  if (/linux/i.test(ua)) return 'Linux · browser';
  return ua.slice(0, 80) || 'Unknown device';
}

export function fail(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

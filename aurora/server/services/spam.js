import { get, run, now, platformSetting } from '../db/index.js';

/**
 * Anti-spam engine:
 * - new accounts (<24h) get tighter hourly message caps
 * - per-minute caps for everyone
 * - duplicate-message flood detection → temporary restriction
 */
const recent = new Map(); // userId -> [{t, chatId, text}]

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of recent) {
    const kept = v.filter((m) => t - m.t < 3600_000);
    if (kept.length) recent.set(k, kept); else recent.delete(k);
  }
}, 300_000).unref();

export function checkMessageSpam(user, chatId, text) {
  const limits = platformSetting('limits', {});
  const t = Date.now();
  const hist = recent.get(user.id) || [];
  hist.push({ t, chatId, text: (text || '').trim().toLowerCase().slice(0, 120) });
  recent.set(user.id, hist);

  const isNew = Date.now() - new Date(user.created_at.replace(' ', 'T') + 'Z').getTime() < 24 * 3600 * 1000;
  const perHour = isNew ? (limits.newAccountMessageLimitPerHour ?? 40) : 1000;
  const perMin = limits.establishedMessageLimitPerMinute ?? 30;

  const lastHour = hist.filter((m) => t - m.t < 3600_000);
  const lastMin = hist.filter((m) => t - m.t < 60_000);

  if (lastHour.length > perHour)
    return { blocked: true, reason: isNew ? 'New accounts have a temporary messaging limit. Please try again later.' : 'Message limit reached. Slow down.' };
  if (lastMin.length > perMin)
    return { blocked: true, reason: 'You are sending messages too fast. Please wait a moment.' };

  // duplicate flood: same text 5+ times within 60s
  const current = hist[hist.length - 1].text;
  if (current && lastMin.filter((m) => m.text === current).length >= 5) {
    const until = new Date(t + 10 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    run(`UPDATE users SET restricted_until=? WHERE id=?`, until, user.id);
    recent.delete(user.id);
    return { blocked: true, reason: 'Temporarily restricted for suspicious activity (repeated identical messages).' };
  }
  return { blocked: false };
}

export function isRestricted(user) {
  return user.restricted_until && user.restricted_until > now();
}

export function recordLoginAttempt(username, ip, success) {
  run(`INSERT INTO login_attempts(email,username,ip,success) VALUES(?,?,?,?)`, null, username || null, ip || null, success ? 1 : 0);
  // prune old
  run(`DELETE FROM login_attempts WHERE created_at < datetime('now','-7 days')`);
}

/** Brute-force protection: lock by username and by IP after N recent failures. */
export function loginBlocked(username, ip) {
  const byUser = get(
    `SELECT COUNT(*) c FROM login_attempts WHERE (username=? OR email=?) AND success=0 AND created_at > datetime('now','-15 minutes')`,
    username, username
  )?.c || 0;
  const byIp = get(
    `SELECT COUNT(*) c FROM login_attempts WHERE ip=? AND success=0 AND created_at > datetime('now','-15 minutes')`,
    ip
  )?.c || 0;
  if (byUser >= 8 || byIp >= 15) {
    return { blocked: true, reason: 'Too many failed sign-in attempts. Please wait 15 minutes.' };
  }
  return { blocked: false };
}

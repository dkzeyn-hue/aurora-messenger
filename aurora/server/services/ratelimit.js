/**
 * In-memory sliding-window rate limiter (per IP and/or per user).
 * Production note: swap the Map store for Redis to scale horizontally.
 */
const buckets = new Map();

export function rateLimit({ name, windowMs, max, keyFn }) {
  return (req, res, next) => {
    const key = `${name}:${keyFn ? keyFn(req) : req.ip}`;
    const t = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { hits: [] }; buckets.set(key, bucket); }
    bucket.hits = bucket.hits.filter((h) => t - h < windowMs);
    if (bucket.hits.length >= max) {
      const retry = Math.ceil((windowMs - (t - bucket.hits[0])) / 1000);
      res.setHeader('Retry-After', retry);
      return res.status(429).json({ error: 'too_many_requests', message: `Too many requests. Try again in ${retry}s.` });
    }
    bucket.hits.push(t);
    next();
  };
}

// periodic cleanup
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) {
    b.hits = b.hits.filter((h) => t - h < 600000);
    if (b.hits.length === 0) buckets.delete(k);
  }
}, 600000).unref();

export const authLimiter = rateLimit({ name: 'auth', windowMs: 15 * 60 * 1000, max: parseInt(process.env.AUTH_RATELIMIT_MAX || '30', 10) });
export const loginLimiter = rateLimit({ name: 'login', windowMs: 15 * 60 * 1000, max: parseInt(process.env.LOGIN_RATELIMIT_MAX || '10', 10) });
export const uploadLimiter = rateLimit({ name: 'upload', windowMs: 60 * 1000, max: 20 });
export const messageLimiter = rateLimit({ name: 'msg', windowMs: 60 * 1000, max: 60, keyFn: (req) => req.user?.id || req.ip });
export const searchLimiter = rateLimit({ name: 'search', windowMs: 60 * 1000, max: 40, keyFn: (req) => req.user?.id || req.ip });
export const apiLimiter = rateLimit({ name: 'api', windowMs: 60 * 1000, max: 300, keyFn: (req) => req.user?.id || req.ip });

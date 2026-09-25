import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { Server } from 'socket.io';
import { config, ROOT } from './config.js';
import { db, seed } from './db/index.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { chatsRouter } from './routes/chats.js';
import { messagesRouter } from './routes/messages.js';
import { filesRouter, storiesRouter } from './routes/files.js';
import { notificationsRouter } from './routes/notifications.js';
import { searchRouter } from './routes/search.js';
import { adminRouter } from './routes/admin.js';
import { devMailRouter } from './routes/devmail.js';
void devMailRouter; // legacy module kept for reference; no longer mounted (no email auth)
import { initSockets } from './sockets/index.js';
import { apiLimiter } from './services/ratelimit.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// ---- security headers ---------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  // Allow embedding (platform previews, PWA wrappers). Set ALLOW_FRAMING=0 in production
  // to re-enable clickjacking protection via X-Frame-Options: DENY.
  if (process.env.ALLOW_FRAMING === '0') res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ---- CORS (API) ----------------------------------------------------------------
// Auth uses Bearer headers (never cookies), so any origin may call the API.
// This keeps the app working when it's embedded cross-origin (preview frames etc.).
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  else res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '2mb' }));

// ---- API ----------------------------------------------------------------------
app.use('/api/auth', authRouter);
app.use('/api/users', apiLimiter, usersRouter);
app.use('/api/chats', apiLimiter, chatsRouter);
app.use('/api/messages', apiLimiter, messagesRouter);
app.use('/api', filesRouter);                       // /api/uploads, /api/files/:id
app.use('/api/stories', storiesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/search', searchRouter);
app.use('/api/admin', adminRouter);
// app.use('/api/dev', devMailRouter); // dev inbox retired — username-only auth, no email flows

app.get('/api/health', (req, res) => res.json({ ok: true, name: config.appName, time: new Date().toISOString() }));

// ---- SPA (PWA) ------------------------------------------------------------------
const publicDir = path.join(ROOT, 'public');
app.use(express.static(publicDir, { maxAge: '1h', index: 'index.html' }));

// client-side routes → index.html (deep links: /verify/:token, /reset/:token, /join/:code, /u/:name ...)
app.get(/^\/(?!api|socket\.io).*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---- error handling ---------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', message: `File exceeds the ${config.maxUploadMB} MB limit` });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Malformed request body' });
  }
  console.error('[api error]', err);
  res.status(500).json({ error: 'server_error', message: 'Unexpected server error. Please try again.' });
});

// ---- boot ---------------------------------------------------------------------------
await seed();

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 1e6,
  pingTimeout: 30_000,
});
initSockets(io);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`🌌 Aurora server listening on http://0.0.0.0:${config.port} (${config.env})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { db.close(); } catch {} process.exit(0); });
}

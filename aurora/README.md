# 🌌 Aurora Messenger

A complete, production-architecture messaging & social platform — **email-only accounts (no phone number, ever)** — with private chats, groups, channels, stories, voice messages, media sharing, realtime updates, and a full admin/moderation suite.

Built as an **installable PWA (Android-first)** with a **Node.js/Express + SQLite (WAL) + Socket.IO** backend. The storage, database and auth layers are abstracted so the app ports to PostgreSQL, S3 and SMTP without touching routes or UI.

---

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

Seeded accounts (created on first boot):

| Account | Email | Password | Notes |
|---|---|---|---|
| Admin | `admin@aurora.app` | `AuroraAdmin!23` | Full admin dashboard at `#/admin` |
| Nova (demo) | `nova@demo.aurora` | `Demo!Aurora1` | Owner of the public **Aurora Lounge** group |
| Orion (demo) | `orion@demo.aurora` | `Demo!Aurora1` | Demo user |

**Email in this environment:** there is no SMTP server in the sandbox, so Aurora runs in `EMAIL_MODE=dev` — verification links, password resets and security alerts land in the in-app **Dev Inbox** (`#/inbox`, linked from the login & verify screens). Set `EMAIL_MODE=smtp` + `SMTP_*` env vars in production to deliver through a real mail provider (code path already wired via nodemailer).

---

## Feature map

### Authentication & account
- Email + password registration with strong-password validation, live strength meter, username availability check
- Email verification (link or 8-char code), resend, auto-verify when opening the link
- Login with brute-force protection (per-email + per-IP lockout), login attempt audit
- JWT access tokens (15 min) + rotating refresh tokens (30 days, hashed at rest, theft detection revokes the session)
- Session/device management: list devices, revoke one, log out everywhere; password reset revokes all sessions
- Password change, account deletion (cascades chats, media, stories), suspension system
- New-device email alerts

### Messaging
- Direct chats, groups (owner/admin/moderator/member roles), public & private channels
- Text, emoji picker, stickers, images (client-side compression + thumbnails), video (poster + range-streaming), documents, audio, **voice messages with live waveform while recording and waveform playback UI**
- Reply (with quoted preview + jump-to), forward (multi-target), edit, delete for me / for everyone, copy, pin/unpin, save to Saved Messages, reactions (per-chat allowlist), report
- Message pagination (infinite scroll up), in-chat search, global search (people / groups / messages / media with filters)
- Typing indicators, recording indicator, online/last-seen presence, delivered ✓ / read ✓✓ receipts
- Channel posts with anonymous authorship, view counts, per-post comment threads, subscriber stats, slow mode, group admin tools (mute/ban/remove/promote), invite links (revocable, usage limits)

### Stories
- Photo & video stories with captions, emoji, privacy (everyone / contacts / selected / nobody), 1h–48h expiry
- Full-screen viewer with progress bars, tap navigation, pause, viewer list, reactions, replies (delivered into DM with story reference)
- Automatic server-side expiry cleanup (hourly job)

### Notifications
- Realtime via WebSocket: messages, mentions, replies, reactions, story activity, group invites, channel posts, new login
- Per-chat notification toggles, mute, global preferences, unread badges

### Privacy & security
- Per-user privacy controls: last seen, profile photo, who can message / add to groups / find by email / call, forward protection
- Block/unblock, report users/messages/chats/stories, per-chat mutes
- scrypt password hashing (timing-safe compare), rate limiting on every sensitive route, upload MIME/size validation, path-traversal-proof file serving
- **Authorization on every operation**: file downloads verify chat membership / story visibility / photo privacy; chats verify membership; admin routes gated by role; users can never read others' sessions, DMs or private stories

### Admin panel (`#/admin`, admins only)
- Platform stats & 14-day trends, user search/suspend/delete, report queue (act/dismiss with auto-suspend), group/channel moderation, banned username management, signup toggle, rate-limit configuration, login-attempt audit

### UX & performance
- Light/dark/system themes, 8 accent colors, 4 text sizes, aurora wallpapers
- Optimistic message sending, skeleton loaders, empty states, retry buttons for failed sends/uploads
- Offline support: cached chats & messages render instantly, outgoing messages queue in localStorage and auto-flush on reconnect, pending/failed states shown
- PWA: installable, service-worker shell + media caching, safe-area aware, mobile-first 390–520px layout (adapts to tablet/desktop)
- Deep links: `aurora://user/name`, `https://…/u/name`, `/join/CODE` invite links, `/verify/TOKEN`, `/reset/TOKEN`

---

## Architecture

```
aurora/
├── server/                     # Backend (ES modules)
│   ├── index.js                # Express app, security headers, mounts, SPA fallback
│   ├── config.js               # Env, secrets, paths
│   ├── db/
│   │   ├── schema.sql          # 22 tables (users, sessions, chats, messages, stories, …)
│   │   └── index.js            # better-sqlite3 (WAL) + seed
│   ├── middleware/auth.js      # JWT auth, email-verified gate, admin gate
│   ├── routes/                 # auth, users, chats, messages, files, stories,
│   │                           # notifications, search, admin, devmail
│   ├── services/
│   │   ├── passwords.js        # scrypt hashing, strength scoring, tokens
│   │   ├── tokens.js           # JWT + refresh rotation + email tokens
│   │   ├── mail.js             # SMTP w/ dev-inbox fallback
│   │   ├── storage.js          # storage abstraction (local disk today, S3-ready)
│   │   ├── access.js           # central authorization layer
│   │   ├── realtime.js         # Socket.IO rooms, presence, notifications
│   │   ├── ratelimit.js        # sliding-window limiter
│   │   ├── spam.js             # anti-spam engine, restrictions
│   │   └── serialize.js        # privacy-aware payload shaping
│   └── sockets/index.js        # authenticated socket gateway
├── public/                     # PWA frontend (vanilla ES modules, zero build step)
│   ├── index.html, manifest, sw.js, favicon
│   ├── css/styles.css          # design system (themes, components)
│   └── js/
│       ├── utils.js            # API client (token refresh, offline queue), socket, state
│       ├── components.js       # sheets, modals, bubbles, voice recorder, media viewer
│       ├── app.js              # router, boot, auth screens, theme
│       └── views/              # chat, conversation, stories, contacts, discover,
│                               # settings, profile, groupinfo, newchat, admin
├── uploads/                    # object storage (date-partitioned)
├── data/                       # SQLite DB + secrets (gitignored)
└── test/
    ├── e2e.mjs                 # 33-check user journey (registration → logout)
    └── e2e-advanced.mjs        # 20 checks (media, stories, offline, admin, deletion)
```

**Why this stack?** A dependency-free ES-module frontend keeps the app tiny and fast on low-end Android devices (no bundler, ~90 KB of app code total), while the backend isolates every infrastructure concern (db, storage, mail, realtime) behind small service modules so each can be swapped for managed services in production:

| Concern | Here | Production swap |
|---|---|---|
| Database | SQLite (WAL) | PostgreSQL (schema is standard SQL; parameterized queries throughout) |
| File storage | local `uploads/` (S3-style service API) | S3 / MinIO / GCS |
| Email | Dev inbox | SMTP / SendGrid / SES (`EMAIL_MODE=smtp`) |
| Realtime | Socket.IO (single node) | `@socket.io/redis-adapter` |
| Rate limits | in-memory | Redis |

## Environment variables

```bash
PORT=3000
JWT_SECRET=<random 96-hex>          # auto-generated & persisted if omitted
DB_PATH=data/aurora.db
UPLOADS_DIR=uploads
MAX_UPLOAD_MB=64
EMAIL_MODE=dev                      # dev | smtp
SMTP_HOST= SMTP_PORT= SMTP_USER= SMTP_PASS= SMTP_FROM=
BASE_URL=https://aurora.example.com # used in email links
ADMIN_PASSWORD=…                    # first-boot admin password
AUTH_RATELIMIT_MAX=30 LOGIN_RATELIMIT_MAX=10
DEMO_SEED=1                         # 0 disables demo accounts
```

## Testing

```bash
node test/e2e.mjs           # 33 checks: register → verify (dev inbox) → login → DM →
                            # group → channel → settings/themes/privacy → search →
                            # 2nd user → realtime delivery → typing → reactions →
                            # replies → password reset → sessions → logout → 401s
node test/e2e-advanced.mjs  # 20 checks: image upload → media viewer → voice message
                            # w/ waveform → story upload → story viewer → offline
                            # queue & auto-flush → deep links → admin dashboard →
                            # account deletion
```

Both suites drive a real headless Chromium via Playwright.

## API overview

`POST /api/auth/register|login|refresh|logout|logout-all|verify-email|resend-verification|forgot-password|reset-password|change-password` · `GET /api/auth/me|sessions` · `DELETE /api/auth/sessions/:id|/api/auth/account`

`GET|PATCH /api/users/me/full|/api/users/me` · `GET /api/users/:idOrUsername` · `GET /api/users/search/people` · `POST|DELETE /api/users/:id/block` · `POST /api/users/report`

`GET|POST /api/chats` (+`/direct|/group|/channel|/join/:code|/:id/join`) · `GET|PATCH|DELETE /api/chats/:id` · members/pins/invites/stats/media subroutes · `POST /api/chats/:id/read`

`GET|POST /api/messages/chat/:id` · `PATCH|DELETE /api/messages/:id` · `POST /api/messages/:id/react|/forward|/save` · `GET /api/messages/search/global|/search/chat/:id`

`POST /api/uploads` · `GET /api/files/:id` (token-auth, membership-checked, range requests)

`POST|GET /api/stories` (+`/feed|/user/:id|/:id|/:id/view|/:id/react|/:id/viewers`) · `DELETE /api/stories/:id`

`GET /api/notifications` · `GET /api/search?q=&scope=` · `GET /api/search/resolve?target=` · `GET /api/admin/*` · `GET /api/dev/emails` (dev mode)

## Security checklist

- ✅ scrypt password hashing, never plaintext; timing-safe comparison
- ✅ JWT (15 min) + rotating hashed refresh tokens with theft detection
- ✅ Email verification gate before any messaging
- ✅ Rate limits: auth, login, messages, uploads, search, general API
- ✅ Brute-force lockout (8 fails/email, 15 fails/IP per 15 min)
- ✅ Anti-spam: new-account hourly caps, per-minute caps, duplicate-flood auto-restriction
- ✅ Upload validation (MIME allowlists per kind, size caps) + client-side image compression
- ✅ Path-traversal-proof file serving; every file request authorized
- ✅ Parameterized SQL everywhere; security headers (nosniff, frame-deny, referrer-policy)
- ✅ Privacy-aware serialization (last seen/photo/email visibility enforced server-side)
- ✅ Suspended accounts blocked at auth + socket layer; forced logouts propagate live

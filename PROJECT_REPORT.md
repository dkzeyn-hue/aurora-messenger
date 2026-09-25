# Aurora Messenger — Project Report

**Date:** 2026-09-25 · **Status:** Complete & tested · **Stack:** vanilla HTML5/CSS/JS · Node.js 20 · Express 5 · SQLite (better-sqlite3) · Socket.IO 4 · Kotlin/AndroidX

---

## 1. Summary

Aurora is a full-featured, originally-branded messenger built from scratch around one
core decision: **identity is your username, not your email**. Account creation needs
only a username, display name, and password — no email, phone, OTP, or third-party
sign-in anywhere in the flow, and therefore no password recovery (users are warned at
signup). Around that core sits a Telegram-class feature set: realtime DMs, groups,
channels, stories, rich media, granular privacy, moderation tools, an admin dashboard,
and a native Android app — all with zero frontend frameworks.

## 2. Architecture

```
┌─ Client (vanilla HTML5/CSS/JS PWA-style SPA)
│   hash router, view modules, service worker, offline outbox
│        │  REST (fetch, JWT Bearer)  +  WebSocket (Socket.IO)
▼
┌─ Server (Node.js + Express, layered)
│   routes/        auth, users, chats, messages, files, stories,
│                  search, notifications, admin, contacts
│   services/      access control, serialization, storage, realtime,
│                  rate limiting, spam/brute-force, tokens, passwords (scrypt)
│   middleware/    JWT auth, verification (legacy pass-through)
│   sockets/       Socket.IO auth + event wiring
│   db/            SQLite schema + migrations + seed
│        ▼
┌─ SQLite (WAL) + on-disk uploads with per-file authorization
```

Key properties:
- **Stateless API** (JWT access tokens, 15 min) + **refresh sessions** in SQLite
  (30-day, multi-device, revocable individually or all-at-once).
- **Per-file media authorization** — every upload is gated by ownership, chat
  membership, story privacy, or profile-photo privacy rules.
- **Idempotent migrations** run at boot; the email→username auth migration preserved
  all existing users, chats, and media.

## 3. Authentication & Security

| Area | Implementation |
|---|---|
| Identity | username (3–32 chars, `[a-z0-9_]`, unique, case-insensitive, live availability check) |
| Passwords | scrypt (N=16384) with per-user salt; hashes never leave the server |
| Signup | auto-login on success; welcome DM + auto-join official channel |
| Recovery | **none by design** — explicit warning at signup |
| Brute force | per-username (8 fails/15 min) and per-IP (15/15 min) lockouts, plus layered rate limiters |
| Sessions | device-labeled, revocable, `logout-all`, survive server restarts |
| Media | auth-token-gated URLs; `<img>`/`<video>` use short-lived token query params |
| Password change | requires current password; other sessions can be kept or revoked |
| Account deletion | cleans messages, memberships, stories, tokens |

## 4. Feature Checklist

- [x] Register / login / logout (username + password only)
- [x] Multi-device sessions + session management UI
- [x] Direct messages, groups (owner/admin/member roles), public channels
- [x] Realtime: delivery, typing indicators, read receipts, presence (online/last seen)
- [x] Reactions, replies, edit/delete, pin, message search, global search
- [x] Media: images, video (with seek/range), voice notes with waveform, documents
- [x] Stories: 24h expiry, privacy per audience, view lists, progress viewer
- [x] Profile photos: upload/remove, respects viewer privacy settings
- [x] Discover public chats; deep links (`/u/username`); share profile links
- [x] Blocking, reporting, muting; admin dashboard (stats, users, reports, limits)
- [x] Dark/light themes; mobile-first Telegram-style UI
- [x] Offline message queue with auto-send on reconnect
- [x] Android app (Kotlin): native photo picker, mic permission, back navigation,
      runtime-editable server address, connection-error recovery dialog

## 5. Testing

Two Playwright E2E suites drive a real headless browser against the live server:

| Suite | Coverage | Result |
|---|---|---|
| `test/e2e.mjs` | auth lifecycle (register→auto-login→logout→re-login, wrong-password, duplicate username), DMs, groups, channels, settings, privacy, stories, discover, search, realtime delivery, typing, reactions, replies, password change, sessions, security matrix | **42/42** |
| `test/e2e-advanced.mjs` | media uploads (image/voice), media viewer, stories upload/view, offline queue + reconnect, deep links, admin dashboard, role gating, account deletion | **20/20** |

Both suites assert zero unexpected browser console errors and no 4xx/5xx beyond
intentional negative tests.

## 6. Android App

`aurora-android/` — a standard Android Studio project (Kotlin, minSdk 26, targetSdk 34)
that wraps the web app in a WebView and adds native capabilities: file chooser (photo
uploads), RECORD_AUDIO permission bridging for voice messages, back-button history
navigation, state restoration, and a first-launch "Connect to Aurora" screen so the
server address can be changed at runtime. A debug APK is included at
`aurora-android/apk/Aurora-debug.apk`.

## 7. Deployment

- `Dockerfile` (node:20-slim, env-configurable `PORT`/`DB_PATH`/`UPLOADS_DIR`/`JWT_SECRET`)
- `render.yaml` (one-click Render blueprint with health check)
- `DEPLOY.md` — step-by-step for Render, Railway, Fly.io, and any Docker/VPS host,
  plus a backup/restore guide (the entire state is the SQLite file + uploads folder).

## 8. Data & Privacy Notes

- The repository **excludes** `aurora/data/` (SQLite DB, JWT secret) and
  `aurora/uploads/` (user media) — they are created on first boot.
- Demo accounts are seeded automatically (documented in the login screen hints).
- No analytics, no third-party scripts, no external fonts/CDNs — the client is fully
  self-contained.

## 9. Known Limitations / Future Work

- Single-server SQLite — right for small/medium scale; horizontal scaling would need
  Postgres + a queue.
- No push notifications when the app is closed (needs FCM/APNs integration).
- Voice recording requires a secure context (HTTPS) — fine on hosted instances.
- Rate limits are in-memory per process (suitable for single-instance deployments).

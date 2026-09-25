# 🌌 Aurora Messenger

[![Deploy to Render](https://render.com/images/deploy-to-render.svg)](https://render.com/deploy?repo=https://github.com/dkzeyn-hue/aurora-messenger)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/new/github?repo=https%3A%2F%2Fgithub.com%2Fdkzeyn-hue%2Faurora-messenger)
[![Deploy to Fly.io](https://fly.io/deploy/button.svg)](https://fly.io/launch?repo=https://github.com/dkzeyn-hue/aurora-messenger)

**Aurora is now public!** Click one of the buttons above to run your own live instance
in ~3 minutes (log in with GitHub, everything else is automatic — Dockerfile included).
Then share the URL, or install `aurora-android/apk/Aurora-debug.apk` and point it at
your server on first launch.

A complete, original-branded messaging platform — **username + password only**, no email,
no phone, no external auth. Telegram-inspired feature set, built with a vanilla stack
(HTML5 / CSS / JS frontend, Node.js + Express + SQLite + Socket.IO backend) and a native
Kotlin Android app.

```
aurora-messenger/
├── aurora/          → server + web app (Node.js, Express, SQLite, Socket.IO)
├── aurora-android/  → Android Studio project (Kotlin WebView shell) + prebuilt APK
├── README.md        → this file
└── PROJECT_REPORT.md → full engineering report (features, architecture, security, tests)
```

## ✨ Features

- **Auth:** username + password only — live username availability check, auto-login on
  signup, scrypt password hashing, session management (multi-device, logout-all),
  brute-force rate limiting. No email/SMS/OTP, no password recovery (by design, with a
  clear warning at signup).
- **Chats:** direct messages, groups with roles, public channels, realtime delivery,
  typing indicators, read receipts, reactions, replies, editing/deleting, pinning, search.
- **Media:** images, videos, voice messages (waveform), documents — with client-side
  compression, thumbnails, and per-file authorization on the server.
- **Stories:** 24h photo/video stories with privacy controls and view lists.
- **Profiles:** username, display name, avatar upload (from Android's native photo
  picker in the app), bio, online status, last-seen privacy.
- **Privacy:** granular per-user settings (who can see last seen / profile photo / find
  you), blocking, reporting, mute.
- **Admin:** dashboard with platform stats, user management, reports queue, moderation
  (suspend/restrict), login-attempt monitoring.
- **Android app:** Kotlin + WebView shell — native photo picker, microphone permission
  for voice messages, back-button navigation, session persistence, editable server
  address (no rebuild needed to switch hosts).

## 🚀 Quick start (web)

```bash
cd aurora
npm install
npm start
# → http://localhost:3000  (demo accounts are seeded on first boot)
```

## 🤖 Quick start (Android)

Open `aurora-android/` in Android Studio and press Run — or install the prebuilt
`aurora-android/apk/Aurora-debug.apk` directly on a phone. The app asks for a server
address on first launch (any running Aurora instance, local or hosted).

## 🧪 Tests

62 end-to-end tests (Playwright, real headless browser):
`aurora/test/e2e.mjs` (42) + `aurora/test/e2e-advanced.mjs` (20) — covering
registration → auto-login → chat → logout → re-login, messaging, media, stories,
admin, offline queue, and the full auth security matrix.

## 📦 Deploy

See `aurora/DEPLOY.md` (Render / Railway / Fly.io / any Docker host — Dockerfile and
render.yaml included).

## 📄 Report

Read **PROJECT_REPORT.md** for the full engineering report.

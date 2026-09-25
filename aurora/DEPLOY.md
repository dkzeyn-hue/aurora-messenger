# 🚀 Deploying Aurora to a permanent 24/7 host

**Fastest way — one click (pick any):**

- **Render:** [![Deploy to Render](https://render.com/images/deploy-to-render.svg)](https://render.com/deploy?repo=https://github.com/dkzeyn-hue/aurora-messenger)
- **Railway:** [![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/new/github?repo=https%3A%2F%2Fgithub.com%2Fdkzeyn-hue%2Faurora-messenger)
- **Fly.io:** [![Deploy to Fly.io](https://fly.io/deploy/button.svg)](https://fly.io/launch?repo=https://github.com/dkzeyn-hue/aurora-messenger)

Log in with GitHub and the host builds the Dockerfile automatically.

The sandbox host I run for you sleeps between our sessions (and its tunnel URL changes
each wake-up). For an always-on Aurora with a **fixed address**, deploy the `aurora/`
folder to a cloud host with your own account. The app is ready for it: it respects
`PORT`, stores its SQLite DB at `DB_PATH`, uploads at `UPLOADS_DIR`, and reads
`JWT_SECRET` from the environment.

After deploying, open the Android app → **Change server** → enter your new URL. Done.

---

## Option A — Render (easiest, ~5 minutes)

1. Create a free account at **render.com** and push this `aurora/` folder to a GitHub repo.
2. Render Dashboard → **New → Blueprint** → pick the repo. It reads `render.yaml`
   automatically and creates the service.
3. When it finishes you get **`https://your-app.onrender.com`** — HTTPS and WebSockets work.
4. Put that URL into the Android app (Change server) or just open it in any browser.

⚠️ **Free-plan caveat:** the free filesystem is *ephemeral* — the database and uploaded
photos reset whenever the service redeploys (roughly daily idle spins don't wipe it, but
redeploys do). For durable data either attach a paid **Disk** at `/app/data`, or use
Option B/C which have free volumes.

## Option B — Railway (free trial credit, volumes included)

1. **railway.app** → New Project → **Deploy from GitHub repo** (same repo).
2. In the service → **Variables** add: `NODE_ENV=production` and
   `JWT_SECRET=<any long random string>`.
3. Service → **Settings → Storage** → add a Volume mounted at `/app/data`.
4. Settings → Networking → **Generate Domain** → you get `https://xxx.up.railway.app`.

## Option C — Fly.io (free allowances, volumes)

```bash
# after `fly auth signup`:
cd aurora
fly launch --no-deploy            # detects the Dockerfile
fly volumes create aurora_data --size 1
fly secrets set JWT_SECRET=$(openssl rand -hex 24)
fly deploy
```
Answer "yes" when asked to mount `aurora_data` at `/app/data`.

## Any other Docker/VPS host

```bash
docker build -t aurora .
docker run -d -p 80:3000 \
  -v aurora_data:/app/data \
  -e JWT_SECRET=$(openssl rand -hex 24) \
  -e NODE_ENV=production \
  aurora
```
Put your favourite reverse proxy / TLS in front (Caddy makes it a 3-liner).

---

## Environment variables reference

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | listen port (hosts inject this) | `3000` |
| `DB_PATH` | SQLite database file | `data/aurora.db` |
| `UPLOADS_DIR` | uploaded media folder | `uploads` |
| `JWT_SECRET` | session signing key — **set a fixed value** so logins survive restarts | generated & persisted in `data/.jwt-secret` |
| `MAX_UPLOAD_MB` | max upload size | `64` |

## Backups

The whole app state lives in two places: the SQLite file (`DB_PATH`) and the uploads
folder (`UPLOADS_DIR`). Copy both and you have a complete backup. To move the data from
my sandbox host onto your deployment, just download `aurora/data/` from this workspace
— your accounts, chats and media come with you.

## Point the Android app at your host

App → (error dialog) **Change server** → paste `https://your-app.onrender.com`
→ **Connect**. Or edit `ServerConfig.kt` default and rebuild for a distribution build.

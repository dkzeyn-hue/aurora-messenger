-- Aurora Messenger schema (SQLite / WAL). Portable to PostgreSQL with minor type changes.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_verified    INTEGER NOT NULL DEFAULT 0,
  password_hash     TEXT NOT NULL,
  username          TEXT UNIQUE COLLATE NOCASE,
  display_name      TEXT NOT NULL,
  bio               TEXT NOT NULL DEFAULT '',
  avatar_attachment_id INTEGER,
  role              TEXT NOT NULL DEFAULT 'user',       -- user | admin
  status            TEXT NOT NULL DEFAULT 'offline',    -- online | offline
  last_seen_at      TEXT,
  suspended         INTEGER NOT NULL DEFAULT 0,
  suspended_reason  TEXT,
  restricted_until  TEXT,                                -- temporary anti-spam restriction
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id       INTEGER PRIMARY KEY,
  privacy       TEXT NOT NULL DEFAULT '{}',   -- JSON
  notifications TEXT NOT NULL DEFAULT '{}',   -- JSON
  appearance    TEXT NOT NULL DEFAULT '{}',   -- JSON
  data          TEXT NOT NULL DEFAULT '{}'    -- JSON
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  device      TEXT NOT NULL DEFAULT 'Unknown device',
  ip          TEXT,
  current     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS email_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,          -- verify | reset
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dev_emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  link       TEXT,
  code       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL,
  kind        TEXT NOT NULL,          -- image|video|voice|audio|document|avatar|story
  mime        TEXT NOT NULL,
  filename    TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  path        TEXT NOT NULL UNIQUE,
  thumb_path  TEXT,
  width       INTEGER, height INTEGER,
  duration    REAL,
  waveform    TEXT,                    -- JSON array of 0..1 amplitudes
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,          -- direct | group | channel
  name         TEXT NOT NULL DEFAULT '',
  about        TEXT NOT NULL DEFAULT '',
  avatar_attachment_id INTEGER,
  owner_id     INTEGER NOT NULL,
  username     TEXT UNIQUE COLLATE NOCASE,
  is_public    INTEGER NOT NULL DEFAULT 0,
  linked_group_id INTEGER,             -- channel discussion group
  settings     TEXT NOT NULL DEFAULT '{}',  -- slowMode, commentsEnabled, allowedReactions...
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id       INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',  -- owner|admin|moderator|member
  joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
  muted_until   TEXT,
  banned        INTEGER NOT NULL DEFAULT 0,
  last_read_message_id   INTEGER NOT NULL DEFAULT 0,
  last_delivered_message_id INTEGER NOT NULL DEFAULT 0,
  notifications_enabled  INTEGER NOT NULL DEFAULT 1,
  archived      INTEGER NOT NULL DEFAULT 0,
  pinned_order  INTEGER,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);

CREATE TABLE IF NOT EXISTS pinned_messages (
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  pinned_by  INTEGER NOT NULL,
  pinned_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  sender_id     INTEGER,
  anonymous     INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'text',  -- text|image|video|voice|audio|document|sticker|system
  system_kind   TEXT,                           -- member_joined|chat_created|...
  text          TEXT NOT NULL DEFAULT '',
  attachment_id INTEGER,
  reply_to_id   INTEGER,
  fwd_from      TEXT,                            -- JSON {name, chatId, messageId}
  parent_post_id INTEGER,                        -- channel comment thread root
  edited_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  views         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_post_id);

CREATE TABLE IF NOT EXISTS message_deletions (
  message_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS stories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  attachment_id  INTEGER NOT NULL,
  caption        TEXT NOT NULL DEFAULT '',
  overlay        TEXT NOT NULL DEFAULT '[]',   -- JSON layers: text/draw/sticker
  privacy        TEXT NOT NULL DEFAULT 'everyone', -- everyone|contacts|selected|nobody
  selected_users TEXT NOT NULL DEFAULT '[]',   -- JSON array of ids
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id, expires_at);

CREATE TABLE IF NOT EXISTS story_views (
  story_id  INTEGER NOT NULL,
  viewer_id INTEGER NOT NULL,
  reaction  TEXT,
  replied   INTEGER NOT NULL DEFAULT 0,
  viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (story_id, viewer_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,   -- message|mention|reply|reaction|story_reply|story_reaction|group_invite|channel_post|new_login|system
  chat_id    INTEGER,
  message_id INTEGER,
  story_id   INTEGER,
  actor_id   INTEGER,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, id);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,   -- user|message|chat|story
  target_id   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',  -- open|acted|dismissed
  handled_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  max_uses   INTEGER,
  uses       INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS banned_usernames (
  username   TEXT PRIMARY KEY COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT,
  email      TEXT,                               -- legacy column (old attempts)
  ip         TEXT,
  success    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(email, created_at);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, created_at);

CREATE TABLE IF NOT EXISTS platform_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

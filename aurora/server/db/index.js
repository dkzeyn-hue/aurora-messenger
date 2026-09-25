import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, ROOT } from '../config.js';

const schema = fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8');
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(schema);

// ---- helpers -------------------------------------------------------------
export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const tx = (fn) => db.transaction(fn);

// run the auth migration once the helpers above exist
migrateAuth();

/**
 * Auth migration: username (not email) becomes the login identifier.
 * - relaxes users.email to nullable (kept for legacy data only)
 * - adds login_attempts.username
 * - marks every account as fully active (email verification no longer exists)
 * Preserves all users, profiles, chats, messages, stories, media and settings.
 */
function migrateAuth() {
  const userCols = db.pragma('table_info(users)');
  const emailCol = userCols.find((c) => c.name === 'email');
  if (emailCol && emailCol.notnull) {
    console.log('[migrate] users.email → nullable (username is now the primary login identifier)');
    db.exec(`
      BEGIN;
      CREATE TABLE users_migrated (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        email             TEXT UNIQUE COLLATE NOCASE,
        email_verified    INTEGER NOT NULL DEFAULT 1,
        password_hash     TEXT NOT NULL,
        username          TEXT UNIQUE COLLATE NOCASE,
        display_name      TEXT NOT NULL,
        bio               TEXT NOT NULL DEFAULT '',
        avatar_attachment_id INTEGER,
        role              TEXT NOT NULL DEFAULT 'user',
        status            TEXT NOT NULL DEFAULT 'offline',
        last_seen_at      TEXT,
        suspended         INTEGER NOT NULL DEFAULT 0,
        suspended_reason  TEXT,
        restricted_until  TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        last_ip           TEXT
      );
      INSERT INTO users_migrated (id,email,email_verified,password_hash,username,display_name,bio,avatar_attachment_id,role,status,last_seen_at,suspended,suspended_reason,restricted_until,created_at,last_ip)
        SELECT id,email,email_verified,password_hash,username,display_name,bio,avatar_attachment_id,role,status,last_seen_at,suspended,suspended_reason,restricted_until,created_at,last_ip FROM users;
      DROP TABLE users;
      ALTER TABLE users_migrated RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      COMMIT;
    `);
  }
  const attemptCols = db.pragma('table_info(login_attempts)');
  if (!attemptCols.find((c) => c.name === 'username')) {
    db.exec(`ALTER TABLE login_attempts ADD COLUMN username TEXT`);
  }
  run(`UPDATE users SET email_verified=1 WHERE email_verified=0`);
  // refresh seeded copy that referenced the old email-based identity
  run(
    `UPDATE messages SET text='*Welcome to Aurora! 🌌\nAurora is a fast, secure messenger built around your username — no email, no phone number required. Create groups, launch channels, share stories and stay connected.' WHERE text LIKE '%email identity%'`
  );
  run(`UPDATE messages SET text=REPLACE(text, 'loving the email-only signup so far', 'loving the username-only signup so far') WHERE text LIKE '%email-only signup%'`);
}

export function platformSetting(key, fallback) {
  const row = get('SELECT value FROM platform_settings WHERE key=?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
export function setPlatformSetting(key, value) {
  run(
    `INSERT INTO platform_settings(key,value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    key, JSON.stringify(value)
  );
}

// ---- seed ----------------------------------------------------------------
import { hashPassword } from '../services/passwords.js';

export async function seed() {
  const adminEmail = 'admin@aurora.app';
  const existing = get('SELECT id FROM users WHERE email=?', adminEmail);
  if (!existing) {
    const info = run(
      `INSERT INTO users(email,email_verified,password_hash,username,display_name,bio,role)
       VALUES(?,1,?,?,'Aurora Admin','Keeping Aurora safe.','admin')`,
      adminEmail, hashPassword(process.env.ADMIN_PASSWORD || 'AuroraAdmin!23'), 'admin'
    );
    run(`INSERT INTO user_settings(user_id) VALUES(?)`, info.lastInsertRowid);
    console.log('[seed] admin created: admin@aurora.app / ' + (process.env.ADMIN_PASSWORD || 'AuroraAdmin!23'));
  }

  // Official channel with welcome content
  const ch = get(`SELECT id FROM chats WHERE username='aurora'`);
  if (!ch) {
    const admin = get('SELECT id FROM users WHERE email=?', adminEmail);
    const info = run(
      `INSERT INTO chats(type,name,about,owner_id,username,is_public,settings)
       VALUES('channel','Aurora','Official announcements and tips from the Aurora team.',?, 'aurora',1,'{}')`,
      admin.id
    );
    const chatId = info.lastInsertRowid;
    run(`INSERT INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'owner')`, chatId, admin.id);
    const posts = [
      ['Welcome to Aurora! 🌌', 'Aurora is a fast, secure messenger built around your email identity — no phone number required. Create groups, launch channels, share stories and stay connected.'],
      ['Your privacy, your rules', 'Control who can see your last seen, profile photo, stories, and who can message you — all from Settings → Privacy.'],
      ['Tip: Deep links work everywhere', 'Share your profile with aurora://user/yourname or the https link. Groups and channels have invite links too.'],
    ];
    const stmt = run;
    posts.forEach(([title, body]) => {
      stmt(`INSERT INTO messages(chat_id,sender_id,anonymous,kind,text) VALUES(?,NULL,1,'text',?)`, chatId, `*${title}*\n${body}`);
    });
    console.log('[seed] official channel @aurora created');
  }

  // Default platform settings
  if (!get(`SELECT 1 FROM platform_settings WHERE key='limits'`)) {
    setPlatformSetting('limits', {
      signupEnabled: true,
      newAccountMessageLimitPerHour: 40,
      establishedMessageLimitPerMinute: 30,
      maxUploadMB: config.maxUploadMB,
      duplicateMessageWindowSec: 10,
    });
  }
  ['telegram', 'whatsapp', 'admin', 'administrator', 'root', 'system', 'aurora', 'support', 'moderator', 'official']
    .forEach((u) => run(`INSERT OR IGNORE INTO banned_usernames(username) VALUES(?)`, u));

  // ---- demo content (dev only, DEMO_SEED=0 to disable) ----
  if (process.env.DEMO_SEED !== '0' && !get(`SELECT 1 FROM users WHERE username='nova'`)) {
    const demo = [
      ['nova@demo.aurora', 'Nova Starling', 'nova', 'Stargazer · sharing cosmic vibes from the Aurora team ✨'],
      ['orion@demo.aurora', 'Orion Vale', 'orion', 'Building things that glow. Coffee first ☕'],
    ];
    for (const [email, name, username, bio] of demo) {
      const info = run(
        `INSERT INTO users(email,email_verified,password_hash,username,display_name,bio,role) VALUES(?,1,?,?,?,?,'user')`,
        email, hashPassword('Demo!Aurora1'), username, name, bio
      );
      run(`INSERT INTO user_settings(user_id) VALUES(?)`, info.lastInsertRowid);
    }
    const nova = get(`SELECT id FROM users WHERE username='nova'`);
    const orion = get(`SELECT id FROM users WHERE username='orion'`);
    const adminId = get(`SELECT id FROM users WHERE email=?`, adminEmail).id;
    // demo users follow the official channel
    const officialChat = get(`SELECT id FROM chats WHERE username='aurora'`);
    if (officialChat) for (const uid of [nova.id, orion.id]) {
      run(`INSERT OR IGNORE INTO chat_members(chat_id,user_id,role) VALUES(?,?, 'member')`, officialChat.id, uid);
    }
    // public demo group
    const g = run(
      `INSERT INTO chats(type,name,about,owner_id,username,is_public,settings) VALUES('group','Aurora Lounge','A friendly space to hang out, ask questions and share ideas.',?,'lounge',1,'{"slowMode":0,"allowedReactions":["👍","❤️","🔥","🎉","😂","😮","😢","🙏"]}')`,
      nova.id
    );
    for (const uid of [nova.id, orion.id, adminId]) {
      run(`INSERT INTO chat_members(chat_id,user_id,role) VALUES(?,?,?)`, g.lastInsertRowid, uid, uid === nova.id ? 'owner' : 'member');
    }
    const loungePosts = [
      [nova.id, 'Welcome to the Aurora Lounge! 🛋️ Say hi and introduce yourself.'],
      [orion.id, 'Hey everyone! Just migrated here from other messengers — loving the email-only signup so far.'],
      [nova.id, 'Reminder: you can pin important messages by holding them, and search everything from the top bar.'],
    ];
    for (const [uid, text] of loungePosts) {
      run(`INSERT INTO messages(chat_id,sender_id,kind,text) VALUES(?,?,'text',?)`, g.lastInsertRowid, uid, text);
    }

    // demo story (generated gradient image) for @nova
    try {
      const { saveAttachment } = await import('../services/storage.js');
      const W = 360, H = 640;
      const rgb = (x, y) => {
        const r = Math.round(60 + 120 * x / W + 40 * Math.sin(y / 90));
        const g2 = Math.round(30 + 90 * y / H);
        const b = Math.round(140 + 100 * (1 - x / W));
        return [r, g2, b];
      };
      const rows = [];
      for (let y = 0; y < H; y++) {
        rows.push(Buffer.from([0])); // filter byte
        for (let x = 0; x < W; x++) {
          const [r, g2, b] = rgb(x, y);
          rows.push(Buffer.from([r, g2, b]));
        }
      }
      const raw = Buffer.concat(rows);
      const zlib = await import('node:zlib');
      const crc32 = (buf) => {
        let c, crc = 0xffffffff;
        for (let n = 0; n < buf.length; n++) {
          c = (crc ^ buf[n]) & 0xff;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          crc = (crc >>> 8) ^ c;
        }
        return (crc ^ 0xffffffff) >>> 0;
      };
      const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
      ]);
      const att = saveAttachment({ ownerId: nova.id, kind: 'story', mime: 'image/png', filename: 'story.png', buffer: png, meta: { width: W, height: H } });
      run(
        `INSERT INTO stories(user_id,attachment_id,caption,overlay,privacy,selected_users,expires_at)
         VALUES(?,?,?,?,'everyone','[]', datetime('now','+24 hours'))`,
        nova.id, att.id, 'Sunset gradient from the Aurora lab 🌅', '[]'
      );
    } catch (e) { console.warn('[seed] story skipped:', e.message); }

    console.log('[seed] demo users @nova @orion (password Demo!Aurora1) + public group @lounge + demo story created');
  }
}

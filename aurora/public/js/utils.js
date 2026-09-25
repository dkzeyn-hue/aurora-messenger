/* ============================================================
   Aurora client core: state, API client, realtime, offline queue
   ============================================================ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
};

/* ---------- storage ---------- */
export const LS = {
  get(k, d) { try { const v = localStorage.getItem('aurora:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('aurora:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('aurora:' + k); } catch {} },
};

/* ---------- global state ---------- */
export const State = {
  user: null,
  settings: { theme: 'system', accent: '#7c5cff', wallpaper: 'aurora', fontSize: 'medium', bubbles: 'rounded' },
  chats: [],
  notifications: [],
  unreadNotifs: 0,
  socket: null,
  online: navigator.onLine,
  sessionId: LS.get('sessionId', null),
  route: { name: 'chat', params: {} },
  typingTimers: new Map(),
  pendingUploads: new Map(),
};
export const cache = {
  messages: LS.get('msgCache', {}),   // chatId -> [messages]
  chats: LS.get('chatCache', []),
};
export function saveMsgCache(chatId, msgs) {
  cache.messages[chatId] = msgs.slice(-60);
  const keys = Object.keys(cache.messages);
  if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete cache.messages[k];
  LS.set('msgCache', cache.messages);
}
export function saveChatCache() {
  cache.chats = State.chats.slice(0, 50);
  LS.set('chatCache', cache.chats);
}

/* ---------- auth token pair ---------- */
let accessToken = LS.get('at', null);
let refreshToken = LS.get('rt', null);
let refreshing = null;

export const hasSession = () => !!(accessToken && refreshToken);
export const clearSession = () => {
  accessToken = refreshToken = null; State.sessionId = null;
  LS.del('at'); LS.del('rt'); LS.del('sessionId');
  LS.del('msgCache'); LS.del('chatCache');
};

async function doRefresh() {
  const res = await fetch('/api/auth/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, device: deviceLabel() }),
  });
  if (!res.ok) throw new Error('refresh failed');
  const data = await res.json();
  accessToken = data.accessToken; refreshToken = data.refreshToken; State.sessionId = data.sessionId;
  LS.set('at', accessToken); LS.set('rt', refreshToken); LS.set('sessionId', State.sessionId);
  return accessToken;
}

export async function getAccess() {
  if (!accessToken) return null;
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1]));
    if (payload.exp * 1000 < Date.now() + 20000) {
      if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
      return await refreshing;
    }
  } catch { return accessToken; }
  return accessToken;
}

export function setTokens(at, rt, sid) {
  accessToken = at; refreshToken = rt; State.sessionId = sid;
  LS.set('at', at); LS.set('rt', rt); LS.set('sessionId', sid);
}

/* ---------- API client with offline queue ---------- */
const outbox = LS.get('outbox', []);
function persistOutbox() { LS.set('outbox', outbox); }
export const outboxCount = () => outbox.length;

async function rawApi(method, path, body, opts = {}) {
  const token = await getAccess();
  const headers = {};
  if (token && !opts.noAuth) headers['Authorization'] = 'Bearer ' + token;
  let payload = body;
  if (body && !(body instanceof FormData) && !opts.raw) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

export async function api(method, path, body, opts = {}) {
  // queueable messages go to outbox when offline
  if (!State.online && opts.queue && hasSession()) {
    outbox.push({ id: 'ob' + Date.now() + Math.random().toString(36).slice(2, 6), method, path, body, meta: opts.meta || {} });
    persistOutbox();
    return { ok: false, offline: true, queued: true, data: { message: 'Offline — message queued' } };
  }
  let r;
  try {
    r = await rawApi(method, path, body, opts);
  } catch {
    return { ok: false, offline: true, data: { message: 'Network unavailable — you appear to be offline' } };
  }
  if (r.status === 401 && refreshToken && !opts.noAuth) {
    try { await (refreshing || doRefresh()); r = await rawApi(method, path, body, opts); }
    catch { clearSession(); onAuthLost(); }
  }
  if (!r.ok && r.status === 401 && !refreshToken) onAuthLost();
  return r;
}
export const GET = (p, o) => api('GET', p, null, o);
export const POST = (p, b, o) => api('POST', p, b, o);
export const PATCH = (p, b, o) => api('PATCH', p, b, o);
export const DEL = (p, b, o) => api('DELETE', p, b, o);

let authLostHandler = () => location.hash = '#/auth/login';
export function onAuthLost(fn) { fn ? (authLostHandler = fn) : authLostHandler(); }

export async function flushOutbox(notify) {
  if (!State.online || !outbox.length) return 0;
  const items = outbox.splice(0, outbox.length);
  persistOutbox();
  let sent = 0;
  for (const item of items) {
    const r = await rawApi(item.method, item.path, item.body, {});
    if (r.ok) { sent++; notify?.(item); }
    else if (r.status >= 500 || r.offline) outbox.push(item); // retry later; 4xx = drop
  }
  persistOutbox();
  return sent;
}

/* ---------- file upload with progress ---------- */
export function uploadFile(file, kind, meta = {}, onProgress, thumbBlob = null) {
  return new Promise(async (resolve, reject) => {
    if (!State.online) return reject(new Error('You are offline. Please try again when connected.'));
    const token = await getAccess();
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind);
    if (meta) fd.append('meta', JSON.stringify(meta));
    if (thumbBlob) fd.append('thumb', thumbBlob, 'thumb.jpg');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data.attachment);
        else reject(new Error(data.message || 'Upload failed'));
      } catch { reject(new Error('Upload failed')); }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    xhr.send(fd);
  });
}
export function fileUrl(id) {
  return '/api/files/' + id;
}
export async function mediaUrl(id) {
  const token = await getAccess();
  return `/api/files/${id}?token=${encodeURIComponent(token)}`;
}
/** Synchronous media URL using the in-memory access token (for <img>/<video> src). */
export function mediaUrlSync(id) {
  return '/api/files/' + id + (accessToken ? '?token=' + encodeURIComponent(accessToken) : '');
}

/* ---------- realtime ---------- */
export function connectSocket() {
  if (State.socket) { State.socket.disconnect(); State.socket = null; }
  if (!hasSession()) return;
  if (typeof io === 'undefined') {
    console.warn('[socket] socket.io client not loaded — realtime disabled (app still works)');
    return null;
  }
  const sock = io({ auth: { token: accessToken }, transports: ['websocket', 'polling'] });
  State.socket = sock;
  sock.on('connect', () => {
    State.online = true;
    document.dispatchEvent(new CustomEvent('aurora:connect'));
    flushOutbox((item) => document.dispatchEvent(new CustomEvent('aurora:outbox-sent', { detail: item })));
  });
  sock.on('disconnect', (reason) => {
    if (reason === 'io client disconnect') return;
    document.dispatchEvent(new CustomEvent('aurora:disconnect'));
  });
  sock.on('connect_error', () => document.dispatchEvent(new CustomEvent('aurora:disconnect')));
  const fwd = ['message:new', 'message:edited', 'message:deleted', 'message:reaction', 'message:pinned', 'message:unpinned',
    'typing', 'recording', 'presence', 'messages:read', 'chat:new', 'chat:updated', 'chat:deleted', 'chat:members_added',
    'chat:member_joined', 'chat:member_left', 'chat:member_removed', 'chat:member_updated', 'chat:removed',
    'notification', 'story:new', 'story:viewed', 'story:reaction', 'story:deleted', 'session_revoked', 'forced_logout'];
  for (const evt of fwd) {
    sock.on(evt, (payload) => {
      if (evt === 'forced_logout') { clearSession(); onAuthLost(); toast(payload?.reason || 'Signed out', 'err'); return; }
      if (evt === 'session_revoked' && payload?.sessionId === State.sessionId) { clearSession(); onAuthLost(); toast('This device was signed out', 'err'); return; }
      if (evt === 'chat:new' && payload?.id) sock.emit('chat:join', { chatId: payload.id }); // join the new room for live updates
      document.dispatchEvent(new CustomEvent('aurora:' + evt, { detail: payload }));
    });
  }
  return sock;
}

/* ---------- helpers ---------- */
export function deviceLabel() {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'Android · ' + (ua.match(/Android [\d.]+/)?.[0] || 'PWA');
  if (/iphone|ipad/i.test(ua)) return 'iOS · Aurora PWA';
  if (/windows/i.test(ua)) return 'Windows · ' + (ua.match(/(Chrome|Firefox|Edg)\/\d+/)?.[0] || 'browser');
  if (/macintosh/i.test(ua)) return 'macOS · browser';
  if (/linux/i.test(ua)) return 'Linux · browser';
  return 'Web browser';
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function fmtDay(iso) {
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  const today = new Date(); const yest = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
}
export function fmtRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export function fmtListTime(iso) {
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return fmtTime(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
export function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'K';
  return String(n ?? 0);
}
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function linkify(text) {
  let html = escapeHtml(text);
  html = html.replace(/(https?:\/\/[^\s<]+)/g, (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m.length > 48 ? m.slice(0, 45) + '…' : m}</a>`);
  html = html.replace(/(^|\s)@([a-z0-9_]{3,32})/gi, (m, sp, name) => `${sp}<a href="#/user/${name}" class="mention">@${name}</a>`);
  html = html.replace(/(^|\s)\*([^*\n]+)\*/g, (m, sp, t) => `${sp}<b>${t}</b>`);
  html = html.replace(/(^|\s)_([^_\n]+)_/g, (m, sp, t) => `${sp}<i>${t}</i>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return html;
}
export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}
const PALETTE = [
  ['#7c5cff', '#4cc9f0'], ['#ff6b9d', '#b967ff'], ['#38d39f', '#4cc9f0'], ['#ffb454', '#ff6b6b'],
  ['#4cc9f0', '#38d39f'], ['#b967ff', '#ff6b9d'], ['#ff8fab', '#ffb454'], ['#6a4dff', '#38d39f'],
  ['#f4a261', '#e76f51'], ['#00b4d8', '#90e0ef'],
];
export function hueFor(id) { return PALETTE[(+id || 0) % PALETTE.length]; }
export function avatarEl(user, size = '', opts = {}) {
  const grad = hueFor(user?.id ?? 0);
  const a = el('div', { class: `avatar ${size} ${opts.square ? 'sq' : ''}` });
  if (opts.ring) {
    const ring = el('div', { class: 'story-ring' + (opts.seen ? ' seen' : '') });
    ring.append(a); a.classList.add('story-inner');
    // move online dot outside
  }
  if (user?.avatar) {
    // avatars are gated by auth: media tags can't send headers, so append the access token
    const fileId = String(user.avatar).split('/').pop();
    a.append(el('img', { src: mediaUrlSync(fileId), alt: '', loading: 'lazy' }));
  } else {
    a.style.background = `linear-gradient(135deg, ${grad[0]}, ${grad[1]})`;
    a.style.color = '#fff';
    a.append(initials(user?.displayName || user?.username || '?'));
  }
  if (opts.online) a.append(el('i', { class: 'online-dot' }));
  if (opts.badge) a.append(opts.badge);
  return opts.ring ? a.parentElement : a;
}
export async function avatarUrlFor(user) {
  // for contexts needing a raw URL with token (canvas, etc.)
  if (user?.avatar) return mediaUrl(user.avatar.split('/').pop());
  return null;
}

/* ---------- icons ---------- */
const I = (paths, vb = '0 0 24 24') => (size = 22) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', vb); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = paths;
  return svg;
};
export const icons = {
  back: I('<path d="M15 5l-7 7 7 7"/>'),
  send: I('<path d="M4.5 12h14M12.5 5.5L19 12l-6.5 6.5"/>', '0 0 24 24'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  chat: I('<path d="M21 12a8.5 8.5 0 01-8.5 8.5c-1.6 0-3-.4-4.3-1L3 21l1.6-4.8A8.5 8.5 0 1121 12z"/>'),
  story: I('<circle cx="12" cy="12" r="9" stroke-dasharray="4 3"/><circle cx="12" cy="12" r="4.5"/>'),
  contacts: I('<circle cx="9" cy="9" r="3.5"/><path d="M3.5 20c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5M16 4.6a3.4 3.4 0 010 8.8M17.5 15.4c2 .7 3.3 2.2 3.8 4.6"/>'),
  discover: I('<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>'),
  settings: I('<circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 00-.14-1.4l2-1.55-2-3.46-2.36.95a7 7 0 00-2.42-1.4L13.7 2.6h-3.4l-.38 2.54a7 7 0 00-2.42 1.4l-2.36-.95-2 3.46 2 1.55A7 7 0 005 12c0 .48.05.94.14 1.4l-2 1.55 2 3.46 2.36-.95a7 7 0 002.42 1.4l.38 2.54h3.4l.38-2.54a7 7 0 002.42-1.4l2.36.95 2-3.46-2-1.55c.09-.46.14-.92.14-1.4z"/>'),
  more: I('<circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  edit: I('<path d="M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17z"/><path d="M13.5 6.5l3 3"/>'),
  attach: I('<path d="M20 12.5l-7.8 7.8a4.5 4.5 0 01-6.4-6.4L13.5 6.2a3 3 0 014.3 4.3l-7.8 7.8a1.6 1.6 0 01-2.2-2.2l7-7"/>'),
  emoji: I('<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8M9 9.5h.01M15 9.5h.01"/>'),
  mic: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/>'),
  camera: I('<path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"/><circle cx="12" cy="13.5" r="3.4"/>'),
  image: I('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 17l5-5 4 4 3-3 4 4"/>'),
  video: I('<rect x="3" y="5" width="13" height="14" rx="3"/><path d="M16 10l5-3v10l-5-3"/>'),
  play: I('<path d="M7 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>'),
  pause: I('<rect x="6.5" y="5" width="4" height="14" rx="1.4" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.4" fill="currentColor" stroke="none"/>'),
  check: I('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  doublecheck: I('<path d="M2.5 12.5l4 4L15 8M10 16.5l1 1L21.5 7.5"/>'),
  clock: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2.5"/>'),
  close: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  reply: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h9a7 7 0 017 7v3"/>'),
  forward: I('<path d="M15 14l5-5-5-5"/><path d="M20 9h-9a7 7 0 00-7 7v3"/>'),
  copy: I('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 012-2h9"/>'),
  pin: I('<path d="M15 4l5 5-2 2-1-.5-4.5 4.5.4 3.6a1.6 1.6 0 01-.5 1.4L10 21l-3-8-4-1 4-4.4a1.6 1.6 0 011.4-.5l3.6.4L17 4z" transform="rotate(-8 12 12)"/>'),
  trash: I('<path d="M4 7h16M9 7V5a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 5v2M6.5 7l1 12.5a1.5 1.5 0 001.5 1.4h6a1.5 1.5 0 001.5-1.4L17.5 7"/>'),
  report: I('<path d="M12 3l9.5 17H2.5z"/><path d="M12 9.5v4.5M12 17.2h.01"/>'),
  block: I('<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>'),
  mute: I('<path d="M13.5 4.5L8 9H4.5v6H8l5.5 4.5z"/><path d="M17.5 9.5l4 4M21.5 9.5l-4 4"/>'),
  bell: I('<path d="M18 9.5a6 6 0 10-12 0c0 6-2.5 7-2.5 7h17s-2.5-1-2.5-7M10 20a2.2 2.2 0 004 0"/>'),
  bellOff: I('<path d="M13.5 4.5L8 9H4.5v6H8l5.5 4.5zM3 3l18 18M18 9.5a6 6 0 00-9.3-5"/>'),
  moon: I('<path d="M20.5 14.5A8.5 8.5 0 1110 3.6a7 7 0 0010.5 10.9z"/>'),
  sun: I('<circle cx="12" cy="12" r="4.4"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19"/>'),
  shield: I('<path d="M12 3l7.5 3v5.5c0 4.6-3 8-7.5 9.5-4.5-1.5-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12l2.2 2.2 4.2-4.4"/>'),
  lock: I('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/>'),
  palette: I('<path d="M12 3a9 9 0 100 18c1.5 0 2-.9 2-2 0-1.4-1-1.6-1-2.7 0-.9.7-1.6 1.7-1.6H17a4 4 0 004-4c0-4.2-4-7.7-9-7.7z"/><circle cx="7.8" cy="11" r="1.2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7.3" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="7.8" r="1.2" fill="currentColor" stroke="none"/>'),
  globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>'),
  logout: I('<path d="M9 4H5.5A1.5 1.5 0 004 5.5v13A1.5 1.5 0 005.5 20H9M15 16l4-4-4-4M19 12H9"/>'),
  archive: I('<rect x="3" y="4" width="18" height="4.5" rx="1.5"/><path d="M5 8.5V19a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0019 19V8.5M10 12.5h4"/>'),
  info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6h.01"/>'),
  users: I('<circle cx="9" cy="8.5" r="3.5"/><path d="M3 20c.7-3.4 3-5.2 6-5.2s5.3 1.8 6 5.2M15.5 5.3a3.4 3.4 0 010 6.4M18 14.9c2 .8 3.2 2.4 3.6 5.1"/>'),
  megaphone: I('<path d="M3 10.5v3a1.5 1.5 0 001.5 1.5H7l9 5V4L7 9H4.5A1.5 1.5 0 003 10.5z"/><path d="M19 9a4.5 4.5 0 010 6"/>'),
  link: I('<path d="M10 14a3.5 3.5 0 005 0l3.5-3.5a3.5 3.5 0 00-5-5L12 7"/><path d="M14 10a3.5 3.5 0 00-5 0l-3.5 3.5a3.5 3.5 0 005 5L12 17"/>'),
  download: I('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>'),
  file: I('<path d="M13 3H7a1.8 1.8 0 00-1.8 1.8v14.4A1.8 1.8 0 007 21h10a1.8 1.8 0 001.8-1.8V8.8z"/><path d="M13 3v5.8h5.8"/>'),
  home: I('<path d="M4 11l8-7 8 7M6 9.5V20h12V9.5"/>'),
  admin: I('<path d="M12 3l2.2 4.4 4.8.7-3.5 3.4.8 4.8L12 14l-4.3 2.3.8-4.8L5 8.1l4.8-.7z"/>'),
  eye: I('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  warn: I('<path d="M12 3l9.5 17H2.5z"/><path d="M12 10v4.5M12 17.5h.01"/>'),
  refresh: I('<path d="M20 12a8 8 0 10-2.3 5.6M20 12V6.5M20 12h-5.5"/>'),
  bookmark: I('<path d="M6.5 4h11a1 1 0 011 1v16l-6.5-4.5L5.5 21V5a1 1 0 011-1z"/>'),
  chevron: I('<path d="M9 6l6 6-6 6"/>'),
  gif: I('<rect x="3" y="5" width="18" height="14" rx="3"/><text x="12" y="15" font-size="7" font-weight="800" text-anchor="middle" fill="currentColor" stroke="none">GIF</text>'),
  sticker: I('<path d="M12 3a9 9 0 019 9c0 5-4 9-9 9a9 9 0 010-18z"/><path d="M12 21c0-5 4-9 9-9M8.5 10h.01M14.5 10h.01"/>'),
  heart: I('<path d="M12 20.5s-8.5-4.8-8.5-11A4.6 4.6 0 0112 7a4.6 4.6 0 018.5 2.5c0 6.2-8.5 11-8.5 11z"/>'),
  share: I('<path d="M8.5 13.5L15 17M15 7l-6.5 3.5M18 4.5a2.5 2.5 0 11-.01 5.01A2.5 2.5 0 0118 4.5zM6 9a2.5 2.5 0 11-.01 5.01A2.5 2.5 0 016 9zM18 14.5a2.5 2.5 0 11-.01 5.01A2.5 2.5 0 0118 14.5z"/>'),
  arrowdown: I('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  filter: I('<path d="M4 6h16M7 12h10M10 18h4"/>'),
  star: I('<path d="M12 3.5l2.6 5.2 5.7.9-4.1 4 1 5.7-5.2-2.7-5.2 2.7 1-5.7-4.1-4 5.7-.9z"/>'),
  trend: I('<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>'),
  mail: I('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3.5 7l8.5 6 8.5-6"/>'),
  phone: I('<path d="M6.5 3.5h3l1.5 4.5-2 1.5a12 12 0 005.5 5.5l1.5-2 4.5 1.5v3a2 2 0 01-2.2 2A16.5 16.5 0 014.5 5.7a2 2 0 012-2.2z"/>'),
};
export function icon(name, size) { return icons[name]?.(size) || icons.info(size); }

/* ---------- navigation ---------- */
export function navigate(hash, replace = false) {
  if (replace) location.replace(hash); else location.hash = hash;
}

/* ---------- toast ---------- */
export function toast(msg, type = '', ms = 2600) {
  const t = el('div', { class: `toast ${type}` }, icon(type === 'ok' ? 'check' : type === 'err' ? 'warn' : 'info', 17), el('span', {}, msg));
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 220); }, ms);
}
export function toastErr(r, fallback = 'Something went wrong') {
  toast(r?.data?.message || fallback, 'err');
}

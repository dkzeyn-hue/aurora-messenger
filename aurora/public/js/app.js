/* ============================================================
   Aurora app: router, boot, auth screens, theme
   ============================================================ */
import { el, $, $$, icon, toast, toastErr, GET, POST, setTokens, clearSession, hasSession, State, LS,
  connectSocket, api, deviceLabel, escapeHtml, avatarEl, icons, navigate } from './utils.js';
export { navigate };
import { modal, confirmModal, promptModal } from './components.js';

/* ---------- theme ---------- */
export function applyTheme() {
  const prefs = State.settings;
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = prefs.theme === 'system' ? (prefersDark ? 'dark' : 'light') : prefs.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--accent', prefs.accent || '#7c5cff');
  document.documentElement.style.setProperty('--fs-base', { small: '14px', medium: '15px', large: '16.5px', xlarge: '18px' }[prefs.fontSize] || '15px');
  let meta = $('meta[name=theme-color]');
  meta?.setAttribute('content', theme === 'dark' ? '#0d1022' : '#f4f5fb');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

/* ---------- router ---------- */
const routes = {};
let currentScreen = null;
function parseHash() {
  const h = (location.hash || '#/').replace(/^#\/?/, '').split('?')[0];
  const parts = h.split('/').filter(Boolean);
  return { name: parts[0] || 'chat', params: parts.slice(1) };
}
let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  const { name, params } = parseHash();
  const authFree = ['auth', 'join'];
  if (!State.user && !authFree.includes(name)) {
    navigate('#/auth/login', true); return;
  }
  if (State.user && name === 'auth') { navigate('#/chat', true); return; }
  State.route = { name, params };
  const view = routes[name] || routes.chat;
  const app = $('#app');
  const screen = await view(app, params);
  if (seq !== routeSeq) return; // a newer navigation superseded this render
  if (currentScreen?._cleanup) { try { currentScreen._cleanup(); } catch {} }
  $$('.screen').forEach(s => { if (s._cleanup) { try { s._cleanup(); } catch {} } s.remove(); });
  currentScreen = screen;
  if (currentScreen) {
    currentScreen.classList.add('screen', 'slide-in');
    app.append(currentScreen);
    setTimeout(() => currentScreen?.classList.remove('slide-in'), 300);
  }
}
window.addEventListener('hashchange', route);

/* ---------- shell pieces ---------- */
export function tabbar(active) {
  const tabs = [
    ['chat', 'chat', 'Chats'],
    ['stories', 'story', 'Stories'],
    ['contacts', 'contacts', 'Contacts'],
    ['discover', 'discover', 'Discover'],
    ['settings', 'settings', 'Settings'],
  ];
  const bar = el('div', { class: 'tabbar' });
  for (const [id, ic, label] of tabs) {
    const unread = id === 'chat'
      ? State.chats.reduce((a, c) => a + (c.unreadCount > 0 ? 1 : 0), 0)
      : 0;
    bar.append(el('button', {
      class: 'tab' + (active === id ? ' active' : ''),
      onclick: () => navigate('#/' + id),
    },
    icon(ic, 23),
    el('span', {}, label),
    unread > 0 ? el('i', { class: 'badge' }, unread > 99 ? '99+' : String(unread)) : null));
  }
  return bar;
}
export function appbar(title, { back, actions = [], sub } = {}) {
  const bar = el('div', { class: 'appbar' });
  if (back) bar.append(el('button', { class: 'icon-btn', onclick: () => history.length > 1 ? history.back() : navigate(back) }, icon('back')));
  bar.append(el('div', { style: 'flex:1;min-width:0' },
    el('h1', {}, title),
    sub ? el('div', { class: 'sub' }, sub) : null));
  for (const a of actions) bar.append(a);
  return bar;
}
export function emptyState(iconName, title, text, actionLabel, onAction) {
  return el('div', { class: 'empty' },
    icon(iconName, 54),
    el('h3', {}, title),
    el('p', {}, text),
    actionLabel ? el('button', { class: 'btn btn-soft mt-16', onclick: onAction }, actionLabel) : null);
}

/* ============================================================
   AUTH SCREENS
   ============================================================ */
function authShell(heroTitle, heroSub, card) {
  const wrap = el('div', { class: 'screen auth-wrap fade-in' });
  wrap.append(el('div', { class: 'auth-hero' },
    el('div', { html: `<svg viewBox="0 0 120 120" width="84" height="84"><defs><linearGradient id="ag" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset=".5" stop-color="#4cc9f0"/><stop offset="1" stop-color="#b967ff"/></linearGradient></defs><path d="M60 8 C 85 8 112 30 112 60 C 112 90 85 112 60 112 C 45 112 34 105 28 96 C 46 96 60 84 60 68 C 60 56 50 50 42 50 C 33 50 26 56 24 64 C 18 52 16 40 20 30 C 28 16 44 8 60 8 Z" fill="url(#ag)"/><circle cx="72" cy="46" r="10" fill="#fff" opacity=".92"/></svg>` }),
    el('h1', {}, heroTitle),
    el('p', {}, heroSub)));
  wrap.append(card);
  return wrap;
}
function fieldRow(label, inputEl, hint) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    inputEl,
    hint ? el('div', { class: 'hint' }, hint) : null);
}
function input(placeholder, type = 'text', autocomplete = '') {
  const w = el('div', { class: 'input-wrap' });
  const i = el('input', { placeholder, type, autocomplete, spellcheck: 'false' });
  w.append(i);
  if (type === 'password') {
    const eye = el('button', { class: 'suffix-btn', type: 'button' }, icon('eye', 18));
    eye.addEventListener('click', () => {
      i.type = i.type === 'password' ? 'text' : 'password';
      eye.innerHTML = ''; eye.append(icon(i.type === 'password' ? 'eye' : 'close', 18));
    });
    w.append(eye);
  }
  w.input = i;
  return w;
}
function errorBox(wrap) {
  const box = el('div', { class: 'form-error hidden' });
  wrap.insertBefore(box, wrap.children[1]);
  return {
    show: (msg) => { box.textContent = msg; box.classList.remove('hidden'); },
    hide: () => box.classList.add('hidden'),
  };
}
function okBox(wrap) {
  const box = el('div', { class: 'form-ok hidden' });
  wrap.insertBefore(box, wrap.children[1]);
  return {
    show: (msg) => { box.textContent = msg; box.classList.remove('hidden'); },
    hide: () => box.classList.add('hidden'),
  };
}

/* ---- register (username + display name + password ONLY) ---- */
function registerView() {
  const card = el('div', { class: 'auth-card' });
  card.append(el('div', { class: 'auth-title' }, 'Create your account'), el('div', { class: 'auth-sub' }, 'Username and password only. No email, no phone number, ever.'));
  const err = errorBox(card);
  const username = input('username', 'text', 'username');
  const displayName = input('Your display name', 'text', 'name');
  const pw = input('Create a password', 'password', 'new-password');
  const pw2 = input('Confirm password', 'password', 'new-password');
  // password strength meter
  const meter = el('div', { class: 'pw-meter' }, el('i'), el('i'), el('i'), el('i'), el('i'));
  const pwLabel = el('div', { class: 'pw-label' }, '');
  pw.input.addEventListener('input', () => {
    const v = pw.input.value;
    let score = 0;
    if (v.length >= 8) score++;
    if (v.length >= 12) score++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
    if (/[0-9]/.test(v)) score++;
    if (/[^A-Za-z0-9]/.test(v)) score++;
    const labels = ['Too weak', 'Weak', 'Okay', 'Good', 'Strong', 'Excellent'];
    pwLabel.textContent = v ? labels[score] : '';
    [...meter.children].forEach((b, i) => {
      const colors = ['#ff5d7a', '#ff5d7a', '#ffb454', '#ffb454', '#38d39f', '#38d39f'];
      b.style.background = i < score ? colors[score] : 'var(--bg-3)';
    });
  });
  // username availability
  let unameT;
  const unameHint = el('div', { class: 'hint' }, '3–32 chars: letters, numbers, underscore');
  username.input.addEventListener('input', () => {
    clearTimeout(unameT);
    const u = username.input.value.toLowerCase();
    if (!u) { unameHint.textContent = '3–32 chars: letters, numbers, underscore'; unameHint.style.color = ''; return; }
    unameT = setTimeout(async () => {
      const r = await GET('/api/auth/username-available?username=' + encodeURIComponent(u));
      if (u !== username.input.value.toLowerCase()) return;
      if (r.ok && r.data.ok) { unameHint.textContent = '✓ @' + u + ' is available'; unameHint.style.color = 'var(--ok)'; }
      else { unameHint.textContent = r.data?.message || 'Not available'; unameHint.style.color = 'var(--danger)'; }
    }, 350);
  });
  card.append(
    fieldRow('Username', username, unameHint),
    fieldRow('Display name', displayName),
    fieldRow('Password', pw),
    el('div', { class: 'field' }, el('label', {}, 'Strength'), meter, pwLabel),
    fieldRow('Confirm password', pw2),
  );
  // no-recovery warning (username-only auth has no email/SMS recovery)
  card.append(el('div', {
    style: 'background:rgba(255,180,84,.1);border:1px solid rgba(255,180,84,.3);color:var(--warn);border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.45;margin-bottom:12px',
  }, '⚠️ If you forget your password, your account may not be recoverable. Aurora has no email or phone recovery — store your password safely.'));
  const submit = el('button', { class: 'btn btn-primary btn-block' }, 'Create account');
  submit.addEventListener('click', async () => {
    err.hide();
    if (pw.input.value !== pw2.input.value) return err.show('Passwords do not match.');
    submit.disabled = true; submit.textContent = 'Creating account…';
    const r = await POST('/api/auth/register', {
      username: username.input.value.trim(), displayName: displayName.input.value.trim(),
      password: pw.input.value, confirmPassword: pw2.input.value,
    }, { noAuth: true });
    submit.disabled = false; submit.textContent = 'Create account';
    if (!r.ok) return err.show(r.data?.message || 'Could not create account.');
    // auto-login → straight into the app
    await completeLogin(r.data);
  });
  card.append(submit, el('div', { class: 'auth-switch' }, 'Already have an account? ', el('b', { onclick: () => navigate('#/auth/login') }, 'Sign in')));
  return authShell('Join Aurora', 'A universe of conversations — private chats, groups, channels & stories.', card);
}

/* ---- login (username + password ONLY) ---- */
function loginView() {
  const card = el('div', { class: 'auth-card' });
  card.append(el('div', { class: 'auth-title' }, 'Welcome back'), el('div', { class: 'auth-sub' }, 'Sign in with your username and password.'));
  const err = errorBox(card);
  const username = input('Username or @username', 'text', 'username');
  const pw = input('Password', 'password', 'current-password');
  card.append(fieldRow('Username', username), fieldRow('Password', pw));
  const submit = el('button', { class: 'btn btn-primary btn-block' }, 'Sign in');
  submit.addEventListener('click', async () => {
    err.hide();
    submit.disabled = true; submit.textContent = 'Signing in…';
    const r = await POST('/api/auth/login', { username: username.input.value.trim(), password: pw.input.value, device: deviceLabel() }, { noAuth: true });
    submit.disabled = false; submit.textContent = 'Sign in';
    if (!r.ok) return err.show(r.data?.message || 'Sign-in failed.');
    await completeLogin(r.data);
  });
  card.append(submit);
  card.append(el('div', { class: 'auth-switch' }, 'New to Aurora? ', el('b', { onclick: () => navigate('#/auth/register') }, 'Create an account')));
  card.append(el('div', { class: 'auth-switch', style: 'font-size:12px;color:var(--text-3)' },
    'Demo accounts: ', el('b', {}, 'nova'), ' / ', el('b', {}, 'orion'), ' (Demo!Aurora1) · ', el('b', {}, 'admin'), ' (AuroraAdmin!23)'));
  return authShell('Aurora', 'Fast, secure messaging built around your username.', card);
}

export async function completeLogin(data) {
  setTokens(data.accessToken, data.refreshToken, data.sessionId);
  State.user = data.user;
  LS.set('user', data.user);
  // these are enhancements — a failure in either must never block navigation
  try { await loadSettings(); } catch (e) { console.warn('[login] settings load failed:', e); }
  try { connectSocket(); } catch (e) { console.warn('[login] socket connect failed:', e); }
  navigate('#/chat', true);
  route().catch((e) => console.error('[login] route render failed:', e));
  toast('Welcome, ' + (State.user.displayName?.split(' ')[0] || 'friend') + ' 👋', 'ok');
}

export async function loadSettings() {
  const r = await GET('/api/users/me/full');
  if (r.ok) {
    State.user = r.data.user;
    State.settings = { ...State.settings, ...r.data.user.settings.appearance };
    State.privacy = r.data.user.settings.privacy;
    State.notifPrefs = r.data.user.settings.notifications;
    LS.set('settings', State.settings);
    applyTheme();
  }
}

/* ============================================================
   BOOT
   ============================================================ */
async function boot() {
  // register views
  const views = {
    chat: (await import('./views/chat.js')).default,
    conversation: (await import('./views/conversation.js')).default,
    stories: (await import('./views/stories.js')).default,
    contacts: (await import('./views/contacts.js')).default,
    discover: (await import('./views/discover.js')).default,
    settings: (await import('./views/settings.js')).default,
    profile: (await import('./views/profile.js')).default,
    user: (await import('./views/profile.js')).default,
    admin: (await import('./views/admin.js')).default,
    new: (await import('./views/newchat.js')).default,
    groupinfo: (await import('./views/groupinfo.js')).default,
  };
  for (const [k, v] of Object.entries(views)) routes[k] = v;
  routes.auth = (app, params) => {
    const sub = params[0] || 'login';
    if (sub === 'register') return registerView();
    return loginView();
  };
  routes.join = async (app, params) => { // invite deep link #/join/:code
    const code = params[0];
    if (!hasSession()) { navigate('#/auth/login', true); return; }
    const r = await POST('/api/chats/join/' + code);
    if (r.ok) { toast('Joined ' + (r.data.chat?.name || 'chat'), 'ok'); navigate('#/conversation/' + r.data.chat.id, true); route(); }
    else { toastErr(r, 'Could not join'); navigate('#/chat', true); route(); }
    return null;
  };

  State.settings = { ...State.settings, ...LS.get('settings', {}) };
  applyTheme();

  // register the service worker (PWA install + offline shell)
  // may throw in sandboxed frames — never let it break boot
  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('/sw.js').catch(() => {}); } catch {}
  }

  // restore session
  if (hasSession()) {
    const r = await GET('/api/auth/me');
    if (r.ok) {
      State.user = r.data.user;
      await loadSettings();
      connectSocket();
    } else if (r.status === 401) {
      // token genuinely invalid/expired → drop it
      clearSession();
    } else {
      // server unreachable (e.g. restart) — keep the session, fall back to cached data;
      // the app will reconnect and refresh automatically once the server is back
      State.user = LS.get('user', null);
      if (State.user) { try { connectSocket(); } catch {} }
    }
  }

  // hide boot splash
  const splash = $('#boot-splash');
  if (splash) { splash.classList.add('hide'); setTimeout(() => splash.remove(), 400); }

  // online/offline indicators
  window.addEventListener('online', () => { State.online = true; document.dispatchEvent(new CustomEvent('aurora:connect')); });
  window.addEventListener('offline', () => { State.online = false; document.dispatchEvent(new CustomEvent('aurora:disconnect')); });

  // deep links: aurora://user/x handled via URL ?deeplink= or /u/x path
  const path = location.pathname;
  const dl = path.match(/^\/(u|c|g|join|verify|reset)\/([a-z0-9_-]+)$/i);
  if (dl) {
    const [, kind, val] = dl;
    if (kind === 'u') navigate('#/user/' + val, true);
    else if (kind === 'c' || kind === 'g') navigate('#/chat', true);
    else if (kind === 'join') navigate('#/join/' + val, true);
    history.replaceState(null, '', '/' + location.hash);
  }

  route();
}
boot();

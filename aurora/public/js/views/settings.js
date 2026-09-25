/* ============================================================
   Settings: account, privacy, security, notifications,
   appearance, data, sessions, danger zone
   ============================================================ */
import { el, $, $$, icon, toast, toastErr, GET, POST, PATCH, DEL, State, navigate, avatarEl, LS, fmtBytes } from '../utils.js';
import { tabbar, appbar } from '../app.js';
import { sheet, confirmModal, promptModal, contextMenu } from '../components.js';
import { applyTheme } from '../app.js';

export default async function settingsView(app) {
  const wrap = el('div', { class: 'screen' });
  wrap.append(appbar('Settings'));
  const content = el('div', { class: 'content' });
  wrap.append(content, tabbar('settings'));

  await refreshUser();
  function refreshUser() {
    return GET('/api/users/me/full').then((r) => { if (r.ok) { State.user = r.data.user; State.privacy = r.data.user.settings.privacy; } });
  }

  function saveSettings(patch) {
    return PATCH('/api/users/me/settings', patch).then((r) => {
      if (r.ok) {
        State.settings = { ...State.settings, ...r.data.settings.appearance };
        LS.set('settings', State.settings);
        applyTheme();
      } else toastErr(r);
      return r;
    });
  }

  function group(label, rows) {
    const g = el('div', { class: 'set-group' });
    for (const r of rows) {
      if (r.sep) { g.append(el('div', { style: 'height:1px;background:var(--line);margin-left:54px' })); continue; }
      g.append(el('div', { class: 'set-row', onclick: r.onClick, oncontextmenu: r.onContext },
        r.icon ? el('div', {
          class: 'set-icon',
          style: r.danger ? 'background:rgba(255,93,122,.14);color:var(--danger)' : '',
        }, icon(r.icon, 17)) : null,
        el('div', { class: 'set-main' },
          el('div', { class: 'set-title', style: r.danger ? 'color:var(--danger)' : '' }, r.title),
          r.sub ? el('div', { class: 'set-sub' }, r.sub) : null),
        r.value !== undefined ? el('span', { class: 'set-value' }, r.value) : null,
        r.toggle ? el('label', { class: 'toggle' }, r.toggle, el('i')) : null,
        r.chevron ? icon('chevron', 16) : null));
    }
    const sec = el('div');
    sec.append(el('div', { class: 'section-label' }, label), g);
    return sec;
  }

  function render() {
    content.innerHTML = '';
    // profile card
    content.append(el('div', {
      class: 'row-item', style: 'margin:10px 12px',
      onclick: () => navigate('#/user/' + State.user.username),
    },
    avatarEl(State.user, 'lg'),
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, el('span', { class: 'name', style: 'font-size:17px' }, State.user.displayName)),
      el('div', { class: 'row-sub' }, '@' + State.user.username)),
    icon('chevron')));

    const isAdminUser = State.user.role === 'admin';
    if (isAdminUser) {
      content.append(group('Administration', [
        { icon: 'admin', title: 'Admin dashboard', sub: 'Users, reports, moderation & platform stats', chevron: true, onClick: () => navigate('#/admin') },
      ]));
    }

    content.append(group('Account', [
      { icon: 'user', title: 'Username', sub: '@' + State.user.username, chevron: true, onClick: async () => {
        const v = await promptModal({ title: 'Change username', value: State.user.username, okLabel: 'Change', validate: (x) => /^[a-z0-9_]{3,32}$/.test(x) ? null : '3–32 chars: letters, numbers, underscore' });
        if (!v) return;
        const r = await PATCH('/api/users/me', { username: v });
        if (r.ok) { State.user.username = v; toast('Username updated', 'ok'); render(); } else toast(r.data?.message, 'err');
      } },
      { icon: 'lock', title: 'Change password', sub: 'Use a strong, unique password', chevron: true, onClick: passwordSheet },
      { icon: 'bookmark', title: 'Saved messages', sub: 'Messages you bookmarked', chevron: true, onClick: async () => {
        const r = await POST('/api/chats/direct', { userId: State.user.id });
        if (r.ok) navigate('#/conversation/' + r.data.chat.id);
      } },
    ]));

    content.append(group('Privacy & security', [
      { icon: 'shield', title: 'Privacy controls', sub: 'Last seen, photo, messages, groups', chevron: true, onClick: privacySheet },
      { icon: 'admin', title: 'Active sessions', sub: 'Devices signed in to your account', chevron: true, onClick: sessionsSheet },
      { icon: 'block', title: 'Blocked users', chevron: true, onClick: blockedSheet },
      { icon: 'archive', title: 'Archived chats', chevron: true, onClick: () => navigate('#/chat') },
      { icon: 'logout', title: 'Log out', sub: 'End this session on this device', danger: true, onClick: logoutThis },
      { icon: 'logout', title: 'Log out all devices', sub: 'Sign out everywhere (except this device)', danger: true, onClick: logoutAll },
    ]));

    content.append(group('Notifications', [
      { icon: 'bell', title: 'In-app notification previews', sub: 'Show message text in notifications', toggle: notifToggle('preview'), onClick: (e) => {} },
      { icon: 'bell', title: 'Notification sound', sub: 'Play a sound for new messages', toggle: notifToggle('sound'), onClick: () => {} },
      { icon: 'bell', title: 'Background notifications', sub: 'Notify even when the app is closed (browser permission required)', chevron: true, onClick: async () => {
        if (!('Notification' in window)) return toast('Not supported in this browser', 'err');
        const perm = await Notification.requestPermission();
        toast(perm === 'granted' ? 'Background notifications enabled' : 'Permission denied', perm === 'granted' ? 'ok' : 'err');
      } },
    ]));

    // appearance
    const themeSeg = el('div', { class: 'seg', style: 'margin:8px 12px' });
    for (const [k, label, ic] of [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'phone']]) {
      themeSeg.append(el('button', {
        class: State.settings.theme === k ? 'active' : '',
        onclick: () => {
          State.settings.theme = k;
          $$('button', themeSeg).forEach(b => b.classList.remove('active'));
          themeSeg.children[['light', 'dark', 'system'].indexOf(k)].classList.add('active');
          saveSettings({ appearance: { theme: k } });
          applyTheme();
        },
      }, label));
    }
    const accentRow = el('div', { style: 'display:flex;gap:10px;padding:12px 16px;flex-wrap:wrap' });
    for (const c of ['#7c5cff', '#4cc9f0', '#38d39f', '#ffb454', '#ff6b9d', '#b967ff', '#f4a261', '#6a4dff']) {
      const dot = el('button', {
        style: `width:34px;height:34px;border-radius:50%;background:${c};border:3px solid ${State.settings.accent === c ? 'var(--text)' : 'transparent'}`,
        onclick: () => {
          State.settings.accent = c;
          saveSettings({ appearance: { accent: c } });
          render();
        },
      });
      accentRow.append(dot);
    }
    const fontSizeSeg = el('div', { class: 'seg', style: 'margin:8px 12px' });
    for (const k of ['small', 'medium', 'large', 'xlarge']) {
      fontSizeSeg.append(el('button', {
        class: State.settings.fontSize === k ? 'active' : '',
        onclick: () => { State.settings.fontSize = k; saveSettings({ appearance: { fontSize: k } }); render(); },
      }, k[0].toUpperCase() + k.slice(1).replace('xlarge', 'XL').replace('large', 'L')));
    }
    const appear = el('div');
    appear.append(el('div', { class: 'section-label' }, 'Appearance'));
    const ag = el('div', { class: 'set-group' });
    ag.append(
      el('div', { class: 'set-row', style: 'cursor:default' }, el('div', { class: 'set-icon' }, icon('moon', 17)), el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, 'Theme'), el('div', { class: 'set-sub' }, 'Choose light, dark or follow system'))),
      el('div', { style: 'padding:2px 0 10px' }, themeSeg),
      el('div', { class: 'set-row', style: 'cursor:default' }, el('div', { class: 'set-icon' }, icon('palette', 17)), el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, 'Accent color'))),
      accentRow,
      el('div', { class: 'set-row', style: 'cursor:default' }, el('div', { class: 'set-icon' }, icon('info', 17)), el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, 'Text size'))),
      el('div', { style: 'padding:2px 0 10px' }, fontSizeSeg),
    );
    appear.append(ag);
    content.append(appear);

    content.append(group('Data & storage', [
      { icon: 'download', title: 'Autoplay media', sub: 'When to autoplay videos', value: State.settings.autoplayMedia || 'wifi', chevron: true, onClick: async () => {
        const opts = { wifi: 'On Wi-Fi only', always: 'Always', never: 'Never' };
        sheet({
          title: 'Autoplay media', body: (close) => {
            const w = el('div');
            for (const [k, label] of Object.entries(opts)) {
              w.append(el('div', { class: 'choice-row' + ((State.settings.autoplayMedia || 'wifi') === k ? ' on' : ''), onclick: () => { State.settings.autoplayMedia = k; saveSettings({ data: { autoplayMedia: k } }); close(); render(); } }, el('div', { class: 'radio-dot' }), label));
            }
            return w;
          },
        });
      } },
      { icon: 'refresh', title: 'Clear message cache', sub: 'Free up space by clearing cached conversations', chevron: true, onClick: async () => {
        if (!(await confirmModal('Clear cache?', 'Cached conversations will be removed. Your messages stay on the server.'))) return;
        LS.del('msgCache'); LS.del('chatCache');
        toast('Cache cleared', 'ok');
      } },
      { icon: 'info', title: 'Storage used (cached)', sub: fmtBytes(JSON.stringify(localStorage).length) + ' of local cache', chevron: false },
    ]));

    content.append(group('About', [
      { icon: 'info', title: 'About Aurora', sub: 'Version 1.0.0 · original messaging platform', chevron: true, onClick: () => sheet({
        title: 'About Aurora',
        body: () => el('div', { style: 'padding:6px 10px;color:var(--text-2);font-size:13.5px;line-height:1.6' },
          el('b', { style: 'color:var(--text)' }, 'Aurora 1.0.0'), el('br'),
          'A fast, secure messenger built around your username — no email, no phone number required.', el('br'), el('br'),
          'Features: private chats, groups, channels, stories, voice messages, media sharing, reactions, and privacy-first controls.', el('br'), el('br'),
          'Stack: Node.js + Express + SQLite (WAL) + Socket.IO PWA, production-portable to PostgreSQL and S3 storage.'),
      }) },
      { icon: 'info', title: 'Help & support', sub: 'How Aurora works', chevron: true, onClick: () => sheet({
        title: 'Help',
        body: () => el('div', { style: 'padding:6px 10px;color:var(--text-2);font-size:13.5px;line-height:1.7' },
          '· Find people by their @username (try @admin)', el('br'),
          '· Create groups & channels from the ✏️ button', el('br'),
          '· Share stories from the Stories tab — they expire automatically', el('br'),
          '· Hold a message for reply / forward / react / pin / delete', el('br'),
          '· Deep links: aurora://user/name, /join/CODE, and https links'),
      }) },
      { icon: 'globe', title: 'Language', sub: 'English (more coming)', value: 'EN', onClick: () => toast('More languages coming soon', '') },
    ]));

    content.append(group('Danger zone', [
      { icon: 'trash', title: 'Delete my account', sub: 'Permanently removes your profile, chats, stories and files', danger: true, onClick: deleteAccount },
    ]));
    content.append(el('div', { style: 'text-align:center;color:var(--text-3);font-size:11.5px;padding:18px' }, 'Aurora · made with 💜 · ' + new Date().getFullYear()));
  }

  function notifToggle(key) {
    const t = el('input', { type: 'checkbox' });
    const cur = State.notifPrefs || {};
    t.checked = cur[key] !== false;
    t.addEventListener('change', () => {
      State.notifPrefs = { ...cur, [key]: t.checked };
      saveSettings({ notifications: { [key]: t.checked } });
    });
    return t;
  }

  async function passwordSheet() {
    sheet({
      title: 'Change password',
      body: (close) => {
        const mk = (ph, type = 'password') => el('input', { placeholder: ph, type, style: 'width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;color:var(--text);margin-bottom:9px' });
        const cur = mk('Current password'), nw = mk('New password'), cf = mk('Confirm new password');
        return el('div', {}, cur, nw, cf, el('button', {
          class: 'btn btn-primary btn-block', onclick: async () => {
            if (nw.value !== cf.value) return toast('Passwords do not match', 'err');
            const r = await POST('/api/auth/change-password', { currentPassword: cur.value, newPassword: nw.value });
            if (r.ok) { toast('Password changed', 'ok'); close(); } else toast(r.data?.message, 'err');
          },
        }, 'Update password'));
      },
    });
  }

  function privacyBody() {
    const w = el('div');
    const P = State.privacy || {};
    const opts = [
      ['lastSeen', 'Who can see my last seen', ['everyone', 'contacts', 'nobody']],
      ['profilePhoto', 'Who can see my profile photo', ['everyone', 'contacts', 'nobody']],
      ['whoCanMessage', 'Who can message me', ['everyone', 'contacts', 'nobody']],
      ['whoCanAddToGroups', 'Who can add me to groups', ['everyone', 'contacts', 'nobody']],
      ['whoCanCall', 'Who can call me (future)', ['everyone', 'contacts', 'nobody']],
    ];
    for (const [key, label, choices] of opts) {
      const g = el('div', { class: 'set-group', style: 'margin:0 0 12px' });
      g.append(el('div', { style: 'padding:11px 14px 4px;font-weight:700;font-size:13.5px' }, label));
      for (const c of choices) {
        const row = el('div', { class: 'choice-row' + ((P[key] || 'everyone') === c ? ' on' : '') },
          el('div', { class: 'radio-dot' }), el('div', {}, c[0].toUpperCase() + c.slice(1)));
        row.addEventListener('click', async () => {
          State.privacy[key] = c;
          await saveSettings({ privacy: { [key]: c } });
          row.parentElement.querySelectorAll('.choice-row').forEach(r => r.classList.remove('on'));
          row.classList.add('on');
        });
        g.append(row);
      }
      w.append(g);
    }
    // forward protection toggle
    const t = el('input', { type: 'checkbox' });
    t.checked = !!P.forwardProtection;
    t.addEventListener('change', async () => { State.privacy.forwardProtection = t.checked; await saveSettings({ privacy: { forwardProtection: t.checked } }); });
    w.append(el('div', { class: 'set-group' },
      el('div', { class: 'set-row', style: 'cursor:default' },
        el('div', { class: 'set-icon' }, icon('forward', 17)),
        el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, 'Forward protection'), el('div', { class: 'set-sub' }, 'Limit forwarding of your direct messages')),
        el('label', { class: 'toggle' }, t, el('i')))));
    return w;
  }
  function privacySheet() {
    sheet({ title: 'Privacy controls', body: privacyBody() });
  }

  async function sessionsSheet() {
    sheet({
      title: 'Active sessions',
      body: async (close) => {
        const w = el('div');
        const r = await GET('/api/auth/sessions');
        if (!r.ok) { w.append(el('div', { style: 'padding:14px;color:var(--text-2)' }, r.data?.message || 'Could not load sessions')); return w; }
        for (const s of r.data.sessions) {
          w.append(el('div', { class: 'set-group', style: 'margin:0 0 10px' },
            el('div', { class: 'set-row' },
              el('div', { class: 'set-icon' }, icon(s.isCurrent ? 'check' : 'phone', 17)),
              el('div', { class: 'set-main' },
                el('div', { class: 'set-title' }, s.device + (s.isCurrent ? ' · this device' : '')),
                el('div', { class: 'set-sub' }, (s.ip || '—') + ' · last active ' + s.lastUsedAt.slice(0, 16).replace('T', ' ') + ' UTC')),
              s.isCurrent ? null : el('button', {
                class: 'btn btn-sm btn-danger', onclick: async () => {
                  const res = await DEL('/api/auth/sessions/' + s.id);
                  if (res.ok) { toast('Device signed out', 'ok'); w.innerHTML = ''; w.append(...(await sessionsBody())?.children || []); }
                  else toastErr(res);
                },
              }, 'Revoke'))));
        }
        w.append(el('button', {
          class: 'btn btn-danger btn-block', onclick: async () => {
            if (!(await confirmModal('Log out all other devices?', 'Every other session will be terminated.'))) return;
            const res = await POST('/api/auth/logout-all');
            toast(res.ok ? 'Other devices signed out' : res.data?.message, res.ok ? 'ok' : 'err');
            close();
          },
        }, 'Log out all other devices'));
        return w;
      },
    });
  }

  function blockedSheet() {
    sheet({
      title: 'Blocked users',
      body: async (close) => {
        const w = el('div');
        const r = await GET('/api/users/me/blocks');
        if (!r.ok || !r.data.blocked.length) { w.append(el('div', { style: 'padding:20px;text-align:center;color:var(--text-3)' }, 'Nobody is blocked')); return w; }
        for (const u of r.data.blocked) {
          w.append(el('div', { class: 'row-item' }, avatarEl(u, 'sm'),
            el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, el('span', { class: 'name' }, u.displayName)), el('div', { class: 'row-sub' }, '@' + u.username)),
            el('button', {
              class: 'btn btn-sm btn-soft', onclick: async () => {
                const res = await DEL(`/api/users/${u.id}/block`);
                if (res.ok) { toast('Unblocked', 'ok'); close(); } else toastErr(res);
              },
            }, 'Unblock')));
        }
        return w;
      },
    });
  }

  async function logoutThis() {
    if (!(await confirmModal('Log out?', 'You will need to sign in again on this device.', 'Log out'))) return;
    await POST('/api/auth/logout', { sessionId: State.sessionId });
    doLogout();
  }
  async function logoutAll() {
    if (!(await confirmModal('Log out all devices?', 'All sessions everywhere will be ended.', 'Log out all'))) return;
    await POST('/api/auth/logout-all');
    doLogout();
  }
  async function doLogout() {
    State.socket?.disconnect();
    const { clearSession } = await import('../utils.js');
    clearSession();
    location.hash = '#/auth/login';
    location.reload();
  }

  async function deleteAccount() {
    const pw = await promptModal({ title: 'Delete account permanently?', text: 'This removes your profile, messages, stories and files. Enter your password to confirm.', okLabel: 'Delete forever', type: 'password' });
    if (!pw) return;
    const r = await DEL('/api/auth/account', { password: pw });
    if (r.ok) {
      toast('Account deleted. Goodbye 💫', 'ok');
      doLogout();
    } else toast(r.data?.message || 'Could not delete account', 'err');
  }

  render();
  return wrap;
}

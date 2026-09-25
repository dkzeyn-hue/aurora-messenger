/* ============================================================
   Admin dashboard (#/admin) — platform moderation
   ============================================================ */
import { el, $, $$, icon, toast, toastErr, GET, POST, PATCH, DEL, State, navigate, avatarEl, fmtCount, fmtRelative, mediaUrl } from '../utils.js';
import { appbar, emptyState } from '../app.js';
import { sheet, confirmModal, contextMenu } from '../components.js';

export default async function adminView(app) {
  if (State.user.role !== 'admin') {
    const w = el('div', { class: 'screen' });
    w.append(appbar('Admin'), emptyState('lock', 'Restricted area', 'This dashboard is only for platform administrators.'));
    return w;
  }
  const wrap = el('div', { class: 'screen' });
  wrap.append(appbar('Admin dashboard', { back: '#/settings' }));
  const content = el('div', { class: 'content' });
  wrap.append(content);

  const tabs = el('div', { class: 'search-chips' });
  let tab = 'overview';
  const TABS = [['overview', 'Overview'], ['users', 'Users'], ['reports', 'Reports'], ['chats', 'Chats'], ['settings', 'Settings']];
  for (const [k, label] of TABS) {
    tabs.append(el('button', { class: 'chip-filter' + (tab === k ? ' active' : ''), onclick: () => { tab = k; $$('button', tabs).forEach(b => b.classList.remove('active')); tabs.children[TABS.findIndex(t => t[0] === k)].classList.add('active'); load(); } }, label));
  }
  wrap.append(tabs, content);

  async function load() {
    content.innerHTML = '';
    content.append(el('div', { class: 'list' }, el('div', { class: 'skel', style: 'height:200px;margin:10px' })));
    if (tab === 'overview') await renderOverview();
    if (tab === 'users') await renderUsers();
    if (tab === 'reports') await renderReports();
    if (tab === 'chats') await renderChats();
    if (tab === 'settings') await renderSettings();
  }

  async function renderOverview() {
    const r = await GET('/api/admin/stats');
    content.innerHTML = '';
    if (!r.ok) return content.append(emptyState('warn', 'Stats unavailable', r.data?.message));
    const s = r.data;
    const grid = el('div', { class: 'stat-grid' });
    const cards = [
      [fmtCount(s.users), 'users'], [fmtCount(s.onlineNow), 'online now'],
      [fmtCount(s.messages), 'messages'], [fmtCount(s.messagesToday), 'messages today'],
      [fmtCount(s.groups), 'groups'], [fmtCount(s.channels), 'channels'],
      [fmtCount(s.stories), 'active stories'], [s.storageMB + ' MB', 'media stored'],
      [fmtCount(s.openReports), 'open reports'], [fmtCount(s.newToday), 'new users today'],
    ];
    for (const [v, label] of cards) grid.append(el('div', { class: 'stat-card' }, el('b', {}, String(v)), el('span', {}, label)));
    content.append(grid);
    if (s.signupTrend?.length) {
      content.append(el('div', { class: 'section-label' }, 'Sign-ups · last 14 days'));
      const chart = el('div', { class: 'stat-card', style: 'margin:0 12px' });
      const bars = el('div', { class: 'mini-chart' });
      const max = Math.max(...s.signupTrend.map(x => x.c), 1);
      for (const d of s.signupTrend) bars.append(el('i', { style: `height:${Math.max(4, (d.c / max) * 100)}%`, title: `${d.d}: ${d.c}` }));
      chart.append(bars);
      content.append(chart);
    }
    if (s.messageTrend?.length) {
      content.append(el('div', { class: 'section-label' }, 'Messages · last 14 days'));
      const chart = el('div', { class: 'stat-card', style: 'margin:0 12px 20px' });
      const bars = el('div', { class: 'mini-chart' });
      const max = Math.max(...s.messageTrend.map(x => x.c), 1);
      for (const d of s.messageTrend) bars.append(el('i', { style: `height:${Math.max(4, (d.c / max) * 100)}%`, title: `${d.d}: ${d.c}` }));
      chart.append(bars);
      content.append(chart);
    }
  }

  async function renderUsers(q = '') {
    const r = await GET('/api/admin/users?q=' + encodeURIComponent(q) + '&limit=50');
    content.innerHTML = '';
    const search = el('input', { placeholder: 'Search users…', value: q, style: 'width:calc(100% - 24px);margin:10px 12px 0;padding:11px 14px;border-radius:12px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;color:var(--text)' });
    search.addEventListener('input', debounceAdmin(() => renderUsers(search.value.trim()), 350));
    content.append(search);
    if (!r.ok) return content.append(emptyState('warn', 'Could not load users', r.data?.message));
    const list = el('div', { class: 'list' });
    for (const u of r.data.users) {
      list.append(el('div', {
        class: 'row-item',
        oncontextmenu: (e) => { e.preventDefault(); userMenu(e, u); },
        onclick: (e) => userMenu(e, u),
      },
      avatarEl(u, 'sm'),
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, u.displayName),
          u.role === 'admin' ? el('span', { class: 'badge-role admin' }, 'admin') : null,
          u.suspended ? el('span', { class: 'badge-role', style: 'background:rgba(255,93,122,.15);color:var(--danger)' }, 'suspended') : null,
          null),
        el('div', { class: 'row-sub' }, '@' + u.username)),
      el('span', { class: 'row-time' }, fmtRelative(u.createdAt))));
    }
    if (!r.data.users.length) list.append(emptyState('search', 'No users found', 'Try a different search.'));
    content.append(list);
  }
  function userMenu(e, u) {
    contextMenu(e.clientX, e.clientY, [
      { label: 'Open profile', icon: 'info', onClick: () => navigate('#/user/' + u.username) },
      { sep: true },
      u.suspended
        ? { label: 'Reinstate account', icon: 'check', onClick: async () => { const r = await PATCH(`/api/admin/users/${u.id}/suspend`, { suspend: false }); toast(r.ok ? 'Reinstated' : r.data?.message, r.ok ? 'ok' : 'err'); load(); } }
        : { label: 'Suspend account', icon: 'block', danger: true, onClick: async () => {
            if (!(await confirmModal('Suspend @' + u.username + '?', 'They will be signed out and unable to log in.'))) return;
            const r = await PATCH(`/api/admin/users/${u.id}/suspend`, { suspend: true, reason: 'Suspended by moderation' });
            toast(r.ok ? 'Suspended' : r.data?.message, r.ok ? 'ok' : 'err'); load();
          } },
      { label: 'Delete account & data', icon: 'trash', danger: true, onClick: async () => {
          if (!(await confirmModal('Delete @' + u.username + ' permanently?', 'This removes all their messages, stories and files.'))) return;
          const r = await DEL(`/api/admin/users/${u.id}`);
          toast(r.ok ? 'Deleted' : r.data?.message, r.ok ? 'ok' : 'err'); load();
        } },
    ]);
  }

  async function renderReports() {
    const r = await GET('/api/admin/reports?status=all');
    content.innerHTML = '';
    if (!r.ok) return content.append(emptyState('warn', 'Could not load reports', r.data?.message));
    const list = el('div', { class: 'list' });
    if (!r.data.reports.length) list.append(emptyState('shield', 'No reports', 'When users report abuse, it lands here for review.'));
    for (const rep of r.data.reports) {
      const item = el('div', { class: 'set-group', style: 'margin:0 12px 10px' });
      const tp = rep.targetPreview;
      item.append(el('div', { class: 'set-row', style: 'cursor:default' },
        el('div', { class: 'set-icon' }, icon(rep.targetType === 'user' ? 'contacts' : rep.targetType === 'message' ? 'chat' : rep.targetType === 'story' ? 'story' : 'users', 17)),
        el('div', { class: 'set-main' },
          el('div', { class: 'set-title' }, `#${rep.id} · ${rep.reason} · ${rep.targetType}`),
          el('div', { class: 'set-sub' }, `by @${rep.reporter.username} · ${fmtRelative(rep.createdAt)}`),
          tp ? el('div', { style: 'font-size:12.5px;color:var(--text-2);margin-top:4px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, '→ ' + (tp.displayName || tp.name || tp.text?.slice(0, 50) || tp.caption || ('#' + rep.targetId))) : null,
          rep.details ? el('div', { style: 'font-size:12px;color:var(--text-3);margin-top:2px' }, '"' + rep.details.slice(0, 120) + '"') : null),
        el('span', { class: 'badge-status ' + rep.status }, rep.status)));
      if (rep.status === 'open') {
        const actionsRow = el('div', { style: 'display:flex;gap:8px;padding:0 12px 12px' });
        actionsRow.append(
          el('button', {
            class: 'btn btn-sm btn-danger', onclick: async () => {
              if (!(await confirmModal('Act on report?', 'Mark handled and suspend the reported user (if applicable).'))) return;
              const res = await PATCH(`/api/admin/reports/${rep.id}`, { status: 'acted', suspendTarget: true });
              toast(res.ok ? 'Handled' : res.data?.message, res.ok ? 'ok' : 'err'); load();
            },
          }, 'Take action'),
          el('button', {
            class: 'btn btn-sm btn-soft', onclick: async () => {
              const res = await PATCH(`/api/admin/reports/${rep.id}`, { status: 'dismissed' });
              toast(res.ok ? 'Dismissed' : res.data?.message); load();
            },
          }, 'Dismiss'));
        item.append(actionsRow);
      }
      list.append(item);
    }
    content.append(list);
  }

  async function renderChats(q = '') {
    const r = await GET('/api/admin/chats?q=' + encodeURIComponent(q));
    content.innerHTML = '';
    const search = el('input', { placeholder: 'Search groups & channels…', value: q, style: 'width:calc(100% - 24px);margin:10px 12px 0;padding:11px 14px;border-radius:12px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;color:var(--text)' });
    search.addEventListener('input', debounceAdmin(() => renderChats(search.value.trim()), 350));
    content.append(search);
    if (!r.ok) return content.append(emptyState('warn', 'Could not load chats', r.data?.message));
    const list = el('div', { class: 'list' });
    for (const c of r.data.chats) {
      list.append(el('div', {
        class: 'row-item',
        onclick: (e) => contextMenu(e.clientX, e.clientY, [
          { label: 'Open', icon: 'chat', onClick: () => navigate('#/conversation/' + c.id) },
          { label: 'Info', icon: 'info', onClick: () => navigate('#/groupinfo/' + c.id) },
          { label: 'Delete chat (moderation)', icon: 'trash', danger: true, onClick: async () => {
              if (!(await confirmModal('Delete "' + c.name + '"?', 'All messages will be removed for everyone.'))) return;
              const res = await DEL('/api/admin/chats/' + c.id);
              toast(res.ok ? 'Deleted' : res.data?.message, res.ok ? 'ok' : 'err'); load();
            } },
        ]),
      },
      avatarEl({ id: c.id, displayName: c.name, avatar: c.avatar }, 'sm', { square: true }),
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, c.name), el('span', { class: 'pill-tag' }, c.type), c.isPublic ? el('span', { class: 'pill-tag' }, 'public') : null),
        el('div', { class: 'row-sub' }, (c.username ? '@' + c.username + ' · ' : '') + fmtCount(c.memberCount) + ' members'))));
    }
    if (!r.data.chats.length) list.append(emptyState('search', 'No chats found', null));
    content.append(list);
  }

  async function renderSettings() {
    const r = await GET('/api/admin/settings');
    content.innerHTML = '';
    if (!r.ok) return content.append(emptyState('warn', 'Could not load settings', r.data?.message));
    const limits = r.data.limits;
    const w = el('div', { style: 'padding:12px' });

    const signupT = el('input', { type: 'checkbox' });
    signupT.checked = !!limits.signupEnabled;
    signupT.addEventListener('change', async () => {
      const res = await PATCH('/api/admin/settings', { limits: { signupEnabled: signupT.checked } });
      toast(res.ok ? (signupT.checked ? 'Sign-up enabled' : 'Sign-up disabled') : res.data?.message, res.ok ? 'ok' : 'err');
    });
    w.append(el('div', { class: 'set-group' },
      el('div', { class: 'set-row', style: 'cursor:default' },
        el('div', { class: 'set-icon' }, icon('users', 17)),
        el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, 'Allow new sign-ups'), el('div', { class: 'set-sub' }, 'Temporarily close registration if needed')),
        el('label', { class: 'toggle' }, signupT, el('i')))));

    const numeric = [
      ['newAccountMessageLimitPerHour', 'New-account message limit / hour', 1, 1000],
      ['establishedMessageLimitPerMinute', 'Global message limit / minute', 1, 500],
      ['maxUploadMB', 'Max upload size (MB)', 1, 512],
    ];
    for (const [key, label, min, max] of numeric) {
      const inp = el('input', { type: 'number', value: limits[key], min, max, style: 'width:90px;padding:8px 10px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg-3);outline:none;color:var(--text);text-align:right' });
      w.append(el('div', { class: 'set-group', style: 'margin-top:10px' },
        el('div', { class: 'set-row', style: 'cursor:default' },
          el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, label)),
          inp)));
      inp.addEventListener('change', async () => {
        const res = await PATCH('/api/admin/settings', { limits: { [key]: +inp.value } });
        toast(res.ok ? 'Saved' : res.data?.message, res.ok ? 'ok' : 'err');
      });
    }

    // banned usernames
    w.append(el('div', { class: 'section-label', style: 'padding-left:2px' }, 'Banned usernames'));
    const bu = el('div', { class: 'set-group' });
    const bres = await GET('/api/admin/banned-usernames');
    if (bres.ok) {
      for (const name of bres.data.usernames) {
        bu.append(el('div', { class: 'set-row' },
          el('div', { class: 'set-main' }, el('div', { class: 'set-title' }, '@' + name)),
          el('button', {
            class: 'icon-btn danger', onclick: async () => {
              const res = await DEL('/api/admin/banned-usernames/' + name);
              if (res.ok) { toast('Unbanned', 'ok'); load(); }
            },
          }, icon('trash', 16))));
      }
    }
    bu.append(el('button', {
      class: 'ctx-item', style: 'width:100%;justify-content:center;color:var(--accent)',
      onclick: async () => {
        const { promptModal } = await import('../components.js');
        const v = await promptModal({ title: 'Ban a username', okLabel: 'Ban', validate: (x) => /^[a-z0-9_]{3,32}$/.test(x) ? null : 'Invalid username' });
        if (!v) return;
        const res = await POST('/api/admin/banned-usernames', { username: v });
        toast(res.ok ? 'Banned' : res.data?.message, res.ok ? 'ok' : 'err'); load();
      },
    }, icon('plus', 18), 'Ban username'));
    w.append(bu);
    content.append(w);
  }

  const debounceAdmin = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  await load();
  return wrap;
}

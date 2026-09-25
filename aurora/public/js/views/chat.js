/* ============================================================
   Home: chats list with filters, stories row, FAB
   ============================================================ */
import { el, $, $$, icon, toast, toastErr, GET, POST, State, cache, saveChatCache, navigate, avatarEl,
  fmtListTime, fmtCount, escapeHtml, fmtRelative } from '../utils.js';
import { tabbar, appbar, emptyState } from '../app.js';
import { contextMenu } from '../components.js';

export default async function chatView(app) {
  const wrap = el('div', { class: 'screen' });
  const filterState = { mode: 'all' }; // all | unread | groups | channels | archived
  let searchMode = false;

  wrap.append(appbar('Aurora', {
    actions: [
      el('button', { class: 'icon-btn', onclick: () => startSearch() }, icon('search')),
      el('button', {
        class: 'icon-btn', onclick: (e) => contextMenu(e.clientX, e.clientY, [
          { label: 'Archived chats', icon: 'archive', onClick: () => { filterState.mode = 'archived'; renderList(); } },
          { label: 'New group', icon: 'users', onClick: () => navigate('#/new/group') },
          { label: 'New channel', icon: 'megaphone', onClick: () => navigate('#/new/channel') },
          { label: 'Saved messages', icon: 'bookmark', onClick: () => openSaved() },
          { sep: true },
          { label: 'Log out', icon: 'logout', danger: true, onClick: logoutAll },
        ]),
      }, icon('more')),
    ],
  }));

  const content = el('div', { class: 'content', id: 'chat-list-content' });
  wrap.append(content);
  const fab = el('button', { class: 'fab', onclick: () => navigate('#/new') }, icon('edit', 26));
  wrap.append(fab, tabbar('chat'));

  // ---- data ----
  let chats = [];
  async function loadChats() {
    const r = await GET('/api/chats' + (filterState.mode === 'archived' ? '?archived=1' : ''));
    if (r.ok) {
      State.chats = r.data.chats;
      saveChatCache();
      chats = State.chats;
    } else {
      chats = cache.chats || [];
      if (chats.length) toast('Showing cached chats (offline)', '');
    }
    renderList();
  }

  function chatRow(c) {
    const isChannel = c.type === 'channel';
    const title = c.type === 'direct' ? (c.peer?.displayName || c.name || 'Direct chat') : c.name;
    const last = c.lastMessage;
    let preview = '';
    if (last) {
      if (last.kind === 'system') preview = last.text;
      else if (last.kind === 'text' || last.kind === 'sticker') preview = (last.text || '').slice(0, 90) || '🌈 Sticker';
      else preview = { image: '📷 Photo', video: '🎬 Video', voice: '🎙 Voice message', audio: '🎵 Audio', document: '📎 ' + (last.attachment?.filename || 'File') }[last.kind] || 'Message';
    } else preview = isChannel ? 'No posts yet' : 'Say hello 👋';

    const row = el('div', { class: 'row-item', onclick: () => openChat(c) });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, chatMenuItems(c, () => row.remove()));
    });
    const avatarOpts = c.type === 'direct' ? { online: c.peer?.online && !c.peer?.lastSeenHidden } : { square: true };
    row.append(avatarEl({ id: c.peer?.id ?? c.id, displayName: title, avatar: c.avatar }, '', avatarOpts));
    row.append(el('div', { class: 'row-main' },
      el('div', { class: 'row-title' },
        el('span', { class: 'name' }, title),
        c.pinnedOrder ? icon('pin', 12) : null,
        c.muted ? icon('bellOff', 13) : null,
        isChannel ? el('span', { class: 'pill-tag' }, 'channel') : c.type === 'group' ? el('span', { class: 'pill-tag' }, 'group') : null),
      el('div', { class: 'row-sub' },
        (last && !last.anonymous && last.sender && c.type !== 'direct' && last.kind !== 'system') ? el('b', { style: 'font-weight:600' }, (State.user.id === last.senderId ? 'You' : (last.sender?.displayName || '').split(' ')[0]) + ': ') : null,
        el('span', { class: 'preview' }, preview))));
    row.append(el('div', { class: 'row-meta' },
      el('span', { class: 'row-time' }, last ? fmtListTime(last.createdAt) : ''),
      c.unreadCount > 0 ? el('span', { class: 'chip' + (c.muted ? ' muted' : '') }, c.unreadCount > 99 ? '99+' : String(c.unreadCount)) : null));
    return row;
  }

  function chatMenuItems(c, after) {
    const items = [];
    items.push({ label: c.pinnedOrder ? 'Unpin' : 'Pin to top', icon: 'pin', onClick: async () => { await PATCH_MEMBERSHIP(c.id, { pinned: !c.pinnedOrder }); loadChats(); } });
    items.push({ label: c.muted ? 'Unmute' : 'Mute notifications', icon: c.muted ? 'bell' : 'bellOff', onClick: async () => { await PATCH_MEMBERSHIP(c.id, { notificationsEnabled: !c.notificationsEnabled }); loadChats(); } });
    items.push({ label: c.archived ? 'Unarchive' : 'Archive', icon: 'archive', onClick: async () => { await PATCH_MEMBERSHIP(c.id, { archived: !c.archived }); loadChats(); } });
    if (c.type === 'direct') items.push({ label: 'Delete chat (for me)', icon: 'trash', danger: true, onClick: async () => { await PATCH_MEMBERSHIP(c.id, { archived: true }); loadChats(); toast('Chat hidden'); } });
    else items.push({ label: 'Leave', icon: 'logout', danger: true, onClick: async () => { const r = await POST(`/api/chats/${c.id}/leave`); toastErr(r, r.ok ? 'Left' : undefined); loadChats(); } });
    return items;
  }
  async function PATCH_MEMBERSHIP(id, body) {
    const r = await POST(`/api/chats/${id}/membership`, body);
    if (!r.ok) toastErr(r);
  }

  function openChat(c) { navigate('#/conversation/' + c.id); }
  async function openSaved() {
    const r = await POST('/api/chats/direct', { userId: State.user.id });
    if (r.ok) navigate('#/conversation/' + r.data.chat.id);
  }

  function renderStoriesRow() {
    const active = (State.storyFeed?.groups || []);
    const mine = State.storyFeed?.mine || [];
    const row = el('div', { style: 'display:flex;gap:13px;padding:14px 16px 6px;overflow-x:auto;scrollbar-width:none' });
    // my story bubble
    const me = el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:5px;flex-shrink:0;cursor:pointer', onclick: () => navigate('#/stories') });
    const av = avatarEl(State.user, '', { ring: mine.length > 0 });
    const plus = el('div', {
      style: 'position:absolute;right:-2px;bottom:-2px;width:19px;height:19px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;border:2px solid var(--bg)',
    }, icon('plus', 11));
    av.style.position = 'relative';
    av.append(plus);
    me.append(av, el('span', { style: 'font-size:11px;font-weight:600;color:var(--text-2)' }, 'My story'));
    row.append(me);
    for (const g of active.slice(0, 12)) {
      const seen = g.stories.every(s => s.viewedByMe);
      row.append(el('div', {
        style: 'display:flex;flex-direction:column;align-items:center;gap:5px;flex-shrink:0;cursor:pointer',
        onclick: () => navigate('#/stories?user=' + g.user.id),
      }, avatarEl(g.user, '', { ring: true, seen }),
      el('span', { style: 'font-size:11px;font-weight:600;color:var(--text-2);max-width:58px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, g.user.displayName.split(' ')[0])));
    }
    return row;
  }

  function renderList() {
    content.innerHTML = '';
    if (State.storyFeed !== undefined && filterState.mode === 'all') {
      content.append(renderStoriesRow());
      content.append(el('div', { style: 'height:1px;background:var(--line);margin:8px 16px 0' }));
    }
    // filter chips
    const chips = el('div', { class: 'search-chips' });
    const filters = [['all', 'All'], ['unread', 'Unread'], ['groups', 'Groups'], ['channels', 'Channels'], ['archived', 'Archived']];
    for (const [k, label] of filters) {
      chips.append(el('button', {
        class: 'chip-filter' + (filterState.mode === k ? ' active' : ''),
        onclick: () => { filterState.mode = k; loadChats(); },
      }, label));
    }
    content.append(chips);
    const list = el('div', { class: 'list' });
    let shown = chats;
    if (filterState.mode === 'unread') shown = chats.filter(c => c.unreadCount > 0);
    if (filterState.mode === 'groups') shown = chats.filter(c => c.type === 'group');
    if (filterState.mode === 'channels') shown = chats.filter(c => c.type === 'channel');
    if (!shown.length) {
      list.append(emptyState(filterState.mode === 'archived' ? 'archive' : 'chat',
        filterState.mode === 'archived' ? 'No archived chats' : 'No chats yet',
        filterState.mode === 'archived' ? 'Chats you archive will appear here.' : 'Tap the ✏️ button to find people by @username and start chatting.',
        filterState.mode === 'all' ? 'Start a chat' : null, () => navigate('#/new')));
    } else {
      for (const c of shown) list.append(chatRow(c));
    }
    content.append(list);
  }

  // ---- global search overlay ----
  function startSearch() {
    const searchWrap = el('div', { class: 'screen fade-in' });
    const results = el('div', { class: 'content list' });
    let scope = 'all';
    const inputEl = el('input', { placeholder: 'Search messages, people, groups…', autofocus: '' });
    const bar = el('div', { class: 'appbar' },
      el('button', { class: 'icon-btn', onclick: () => { searchWrap.remove(); } }, icon('back')),
      el('div', { class: 'searchbar', style: 'flex:1;margin:0' }, icon('search', 18), inputEl));
    const chips = el('div', { class: 'search-chips' });
    const doSearch = debounceRun(async (q) => {
      if (q.length < 2) { results.innerHTML = ''; return; }
      results.innerHTML = '';
      for (let i = 0; i < 6; i++) results.append(el('div', { class: 'skel-row' }, el('div', { class: 'skel skel-circle' }), el('div', { class: 'skel-lines' }, el('div', { class: 'skel skel-line', style: 'width:70%' }), el('div', { class: 'skel skel-line', style: 'width:45%' }))));
      const r = await GET('/api/search?q=' + encodeURIComponent(q) + '&scope=' + scope);
      results.innerHTML = '';
      if (!r.ok) return;
      const d = r.data;
      if (d.people?.length) {
        results.append(el('div', { class: 'section-label' }, 'People'));
        for (const u of d.people.slice(0, 8)) {
          results.append(el('div', { class: 'row-item', onclick: () => { searchWrap.remove(); navigate('#/user/' + u.username); } },
            avatarEl(u, '', { online: u.online }),
            el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, el('span', { class: 'name' }, u.displayName)), el('div', { class: 'row-sub' }, '@' + u.username))));
        }
      }
      if (d.chats?.length) {
        results.append(el('div', { class: 'section-label' }, 'Groups & channels'));
        for (const c of d.chats.slice(0, 8)) {
          results.append(el('div', { class: 'row-item', onclick: () => { searchWrap.remove(); navigate(c.myRole ? '#/conversation/' + c.id : '#/user/' + (c.username || c.id)); } },
            avatarEl({ id: c.id, displayName: c.name, avatar: c.avatar }, '', { square: true }),
            el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, el('span', { class: 'name' }, c.name), el('span', { class: 'pill-tag' }, c.type)),
            el('div', { class: 'row-sub' }, (c.username ? '@' + c.username + ' · ' : '') + fmtCount(c.memberCount) + ' members'))));
        }
      }
      if (d.messages?.length) {
        results.append(el('div', { class: 'section-label' }, 'Messages'));
        for (const m of d.messages.slice(0, 20)) {
          results.append(el('div', { class: 'row-item', onclick: () => { searchWrap.remove(); navigate('#/conversation/' + m.chatId + '?jump=' + m.id); } },
            el('div', { class: 'set-icon' }, icon('chat', 17)),
            el('div', { class: 'row-main' }, el('div', { class: 'row-sub' }, el('span', { class: 'preview' }, (m.chatName || 'Chat') + ' · ' + fmtRelative(m.createdAt))),
            el('div', { style: 'font-size:13.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, m.text || '📎 ' + (m.attachment?.filename || 'Media')))));
        }
      }
      if (d.media?.length) {
        results.append(el('div', { class: 'section-label' }, 'Media'));
        const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:0 12px' });
        for (const m of d.media.slice(0, 12)) {
          if (!m.attachment) continue;
          grid.append(el('img', { src: m.attachment.url, loading: 'lazy', style: 'width:100%;height:110px;object-fit:cover;border-radius:10px;cursor:pointer', onclick: () => { searchWrap.remove(); navigate('#/conversation/' + m.chatId + '?jump=' + m.id); } }));
        }
        results.append(grid);
      }
      if (!d.people?.length && !d.chats?.length && !d.messages?.length && !d.media?.length) {
        results.append(emptyState('search', 'Nothing found', 'Try a different search — usernames (@alice), group names or message text.'));
      }
    }, 300);
    inputEl.addEventListener('input', () => doSearch(inputEl.value.trim()));
    for (const [k, label] of [['all', 'All'], ['people', 'People'], ['chats', 'Groups'], ['messages', 'Messages'], ['media', 'Media']]) {
      chips.append(el('button', { class: 'chip-filter' + (scope === k ? ' active' : ''), onclick: (e) => { scope = k; $$('*', chips).forEach(b => b.classList?.remove('active')); e.currentTarget.classList.add('active'); doSearch(inputEl.value.trim()); } }, label));
    }
    searchWrap.append(bar, chips, results);
    app.append(searchWrap);
    setTimeout(() => inputEl.focus(), 80);
  }
  const debounceRun = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  async function logoutAll() {
    if (!(await confirmModal('Log out?', 'You will need to sign in again on this device.', 'Log out'))) return;
    await POST('/api/auth/logout', { sessionId: State.sessionId });
    State.socket?.disconnect();
    clearSessionLocal();
  }
  function clearSessionLocal() {
    import('../utils.js').then(({ clearSession }) => { clearSession(); location.hash = '#/auth/login'; location.reload(); });
  }

  // ---- realtime reactions on list ----
  const onNewMsg = (e) => {
    const m = e.detail.message;
    const chat = State.chats.find(c => c.id === m.chatId);
    if (chat) {
      chat.lastMessage = m;
      if (m.senderId !== State.user.id) chat.unreadCount++;
      chats = [...State.chats];
      if (!searchMode) renderList();
    } else {
      loadChats(); // new chat
    }
  };
  const handler = (ev) => document.addEventListener(ev, onNewMsg);
  document.addEventListener('aurora:message:new', onNewMsg);
  document.addEventListener('aurora:chat:new', () => loadChats());
  document.addEventListener('aurora:chat:updated', () => loadChats());
  document.addEventListener('aurora:messages:read', () => loadChats());
  document.addEventListener('aurora:story:new', refreshStories);

  wrap.addEventListener('DOMNodeRemoved', () => {}); // no-op; views are recreated on nav
  const cleanup = () => {
    document.removeEventListener('aurora:message:new', onNewMsg);
    document.removeEventListener('aurora:chat:new', loadChats);
    document.removeEventListener('aurora:chat:updated', loadChats);
    document.removeEventListener('aurora:messages:read', loadChats);
    document.removeEventListener('aurora:story:new', refreshStories);
  };
  wrap._cleanup = cleanup;

  async function refreshStories() {
    const r = await GET('/api/stories/feed');
    if (r.ok) State.storyFeed = r.data;
  }

  await Promise.all([loadChats(), refreshStories()]);
  renderList();
  return wrap;
}

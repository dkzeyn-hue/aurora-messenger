/* ============================================================
   Contacts: people you know + global user search
   ============================================================ */
import { el, $, icon, toast, toastErr, GET, POST, State, navigate, avatarEl, debounce } from '../utils.js';
import { tabbar, appbar, emptyState } from '../app.js';
import { sheet, contextMenu, confirmModal } from '../components.js';

export default async function contactsView(app) {
  const wrap = el('div', { class: 'screen' });
  wrap.append(appbar('Contacts', {
    actions: [
      el('button', { class: 'icon-btn', onclick: shareMyProfile }, icon('share')),
      el('button', {
        class: 'icon-btn', onclick: (e) => contextMenu(e.clientX, e.clientY, [
          { label: 'Blocked users', icon: 'block', onClick: blockedList },
          { label: 'Invite a friend', icon: 'link', onClick: shareMyProfile },
        ]),
      }, icon('more')),
    ],
  }));

  const search = el('input', { placeholder: 'Find people by @username or name…' });
  wrap.append(el('div', { class: 'searchbar' }, icon('search', 18), search));
  const content = el('div', { class: 'content' });
  wrap.append(content, tabbar('contacts'));

  let contacts = [];

  async function loadContacts() {
    // direct-chat peers from loaded chats + server list
    const r = await GET('/api/chats');
    if (r.ok) {
      State.chats = r.data.chats;
      contacts = State.chats.filter(c => c.type === 'direct' && c.peer).map(c => c.peer);
    }
    render(contacts, false);
  }

  function render(list, isSearch) {
    content.innerHTML = '';
    const listEl = el('div', { class: 'list' });
    if (!list.length) {
      listEl.append(emptyState('contacts', isSearch ? 'No people found' : 'No contacts yet',
        isSearch ? 'Try their @username — Aurora finds people by username.'
          : 'Find people by their @username and start chatting. No phone number needed.',
        isSearch ? null : 'Find people', () => search.focus()));
    } else {
      for (const u of list) {
        const row = el('div', {
          class: 'row-item',
          onclick: () => navigate('#/user/' + u.username),
          oncontextmenu: (e) => {
            e.preventDefault();
            contextMenu(e.clientX, e.clientY, [
              { label: 'Message', icon: 'chat', onClick: async () => { const r = await POST('/api/chats/direct', { userId: u.id }); if (r.ok) navigate('#/conversation/' + r.data.chat.id); } },
              { label: u.blockedByMe ? 'Unblock' : 'Block', icon: 'block', danger: !u.blockedByMe, onClick: () => toggleBlock(u) },
              { label: 'Report', icon: 'report', danger: true, onClick: () => reportUser(u) },
            ]);
          },
        },
        avatarEl(u, '', { online: u.online && !u.lastSeenHidden }),
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, el('span', { class: 'name' }, u.displayName), u.blockedByMe ? el('span', { class: 'pill-tag' }, 'blocked') : null),
          el('div', { class: 'row-sub' }, '@' + u.username + (u.online ? ' · online' : ''))),
        el('button', {
          class: 'icon-btn', onclick: async (e) => {
            e.stopPropagation();
            const r = await POST('/api/chats/direct', { userId: u.id });
            if (r.ok) navigate('#/conversation/' + r.data.chat.id);
            else toastErr(r);
          },
        }, icon('chat', 21)));
        listEl.append(row);
      }
    }
    content.append(listEl);
  }

  async function toggleBlock(u) {
    const doBlock = !u.blockedByMe;
    if (doBlock && !(await confirmModal(`Block @${u.username}?`, 'They will not be able to message you or add you to groups.'))) return;
    const r = doBlock ? await POST(`/api/users/${u.id}/block`) : await (await import('../utils.js')).DEL(`/api/users/${u.id}/block`);
    toast(r.ok ? (doBlock ? 'Blocked' : 'Unblocked') : r.data?.message, r.ok ? 'ok' : 'err');
    loadContacts();
  }
  function reportUser(u) {
    import('../components.js').then(({ sheet }) => {
      const reasons = ['spam', 'abuse', 'harassment', 'pornography', 'violence', 'scam', 'other'];
      sheet({
        title: 'Report @' + u.username,
        body: (close) => {
          const w = el('div');
          for (const r of reasons) {
            w.append(el('button', {
              class: 'ctx-item', style: 'width:100%', onclick: async () => {
                const res = await POST('/api/users/report', { targetType: 'user', targetId: u.id, reason: r });
                close(); toast(res.ok ? 'Report submitted' : res.data?.message, res.ok ? 'ok' : 'err');
              },
            }, r[0].toUpperCase() + r.slice(1)));
          }
          return w;
        },
      });
    });
  }
  function blockedList() {
    sheet({
      title: 'Blocked users',
      body: async (close) => {
        const w = el('div');
        const r = await GET('/api/users/me/blocks');
        if (!r.ok || !r.data.blocked.length) { w.append(emptyState('block', 'Nobody blocked', 'Blocked users appear here.')); return w; }
        for (const u of r.data.blocked) {
          w.append(el('div', { class: 'row-item' },
            avatarEl(u, 'sm'),
            el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, el('span', { class: 'name' }, u.displayName)), el('div', { class: 'row-sub' }, '@' + u.username)),
            el('button', {
              class: 'btn btn-sm btn-soft', onclick: async () => {
                const r2 = await (await import('../utils.js')).DEL(`/api/users/${u.id}/block`);
                if (r2.ok) { toast('Unblocked', 'ok'); u.blockedByMe = false; close(); loadContacts(); }
              },
            }, 'Unblock')));
        }
        return w;
      },
    });
  }
  function shareMyProfile() {
    const link = location.origin + '/u/' + State.user.username;
    if (navigator.share) navigator.share({ title: 'My Aurora profile', text: `Chat with me on Aurora: @${State.user.username}`, url: link }).catch(() => {});
    else {
      navigator.clipboard?.writeText(link);
      toast('Profile link copied: ' + link, 'ok', 3200);
    }
  }

  search.addEventListener('input', debounce(async () => {
    const qv = search.value.trim();
    if (qv.length < 2) return render(contacts, false);
    const r = await GET('/api/users/search/people?q=' + encodeURIComponent(qv));
    if (r.ok) render(r.data.results, true);
  }, 300));

  await loadContacts();
  return wrap;
}

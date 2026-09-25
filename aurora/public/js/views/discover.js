/* ============================================================
   Discover: public groups & channels
   ============================================================ */
import { el, $, icon, toast, toastErr, GET, POST, State, navigate, avatarEl, debounce, fmtCount } from '../utils.js';
import { tabbar, appbar, emptyState } from '../app.js';

export default async function discoverView(app) {
  const wrap = el('div', { class: 'screen' });
  wrap.append(appbar('Discover'));
  const search = el('input', { placeholder: 'Explore public groups & channels…' });
  wrap.append(el('div', { class: 'searchbar' }, icon('search', 18), search));
  const chips = el('div', { class: 'search-chips' });
  let type = null;
  const content = el('div', { class: 'content' });
  wrap.append(chips, content, tabbar('discover'));

  for (const [k, label] of [[null, 'All'], ['channel', 'Channels'], ['group', 'Groups']]) {
    chips.append(el('button', {
      class: 'chip-filter' + (type === k ? ' active' : ''),
      onclick: () => { type = k; $$('button', chips).forEach(b => b.classList.remove('active')); chips.children[[null, 'channel', 'group'].indexOf(k)].classList.add('active'); searchNow(); },
    }, label));
  }

  function chatRow(c) {
    const isMember = !!c.myRole;
    return el('div', { class: 'row-item', onclick: () => openChat(c) },
      avatarEl({ id: c.id, displayName: c.name, avatar: c.avatar }, '', { square: true }),
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title' },
          el('span', { class: 'name' }, c.name),
          el('span', { class: 'pill-tag' }, c.type)),
        el('div', { class: 'row-sub' },
          (c.username ? '@' + c.username : '') + ' · ' + fmtCount(c.memberCount) + (c.type === 'channel' ? ' subscribers' : ' members') + (isMember ? ' · joined' : ''))),
      isMember ? icon('chevron') : el('button', {
        class: 'btn btn-sm btn-soft', onclick: async (e) => {
          e.stopPropagation();
          await openChat(c);
        },
      }, 'Open'));
  }
  async function openChat(c) {
    if (c.myRole) return navigate('#/conversation/' + c.id);
    // preview public channel without joining
    const r = await GET('/api/chats/' + c.id);
    if (r.ok) navigate('#/conversation/' + c.id);
    else toastErr(r);
  }

  async function searchNow() {
    content.innerHTML = '';
    content.append(el('div', { class: 'list' }, ...Array(5).fill(0).map(() =>
      el('div', { class: 'skel-row' }, el('div', { class: 'skel skel-circle' }), el('div', { class: 'skel-lines' }, el('div', { class: 'skel skel-line', style: 'width:60%' }), el('div', { class: 'skel skel-line', style: 'width:40%' }))))));
    const qv = search.value.trim();
    const r = await GET('/api/chats/discover/public?q=' + encodeURIComponent(qv) + (type ? '&type=' + type : ''));
    content.innerHTML = '';
    const list = el('div', { class: 'list' });
    if (!r.ok || !r.data.results.length) {
      list.append(emptyState('discover', 'Nothing here yet', qv ? 'No public ' + (type || 'chats') + ' match “' + qv + '”.' : 'Public groups and channels will appear here. You can create your own from the ✏️ menu.', null));
    } else {
      list.append(el('div', { class: 'section-label' }, qv ? 'Results' : 'Popular now'));
      for (const c of r.data.results) list.append(chatRow(c));
    }
    content.append(list);
  }

  search.addEventListener('input', debounce(searchNow, 350));
  await searchNow();
  return wrap;
}
